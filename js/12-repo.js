/* ══════════════════════════════════════════════════════════════════════════
   MT.repo — the only storage API the rest of the app is allowed to use.

   Everything (views, sync, alerts, the recommender) calls MT.repo. Nothing
   calls MT.db directly. That rule is what makes the deferred GitHub-sync layer
   a drop-in later rather than a rewrite: sync needs exactly one place to
   observe writes and one place to reconcile reads, and this is it.
   ══════════════════════════════════════════════════════════════════════════ */

MT.repo = (function () {
  const listeners = new Set();

  function emit(event, detail) {
    for (const fn of listeners) { try { fn(event, detail); } catch (e) { console.error(e); } }
  }
  function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }

  /* ── Items ─────────────────────────────────────────────────────────── */

  const getItem = uid => MT.db.get('items', uid);
  const allItems = () => MT.db.getAll('items');
  const countItems = () => MT.db.count('items');

  async function putItem(item) {
    item.user = item.user || {};
    item.user.updatedAt = Date.now();
    item.sortTitle = MT.util.sortTitleOf(item.title);
    normalizeIndexable(item);
    await MT.db.put('items', item);
    await writeIdIndex(item);
    emit('item:put', item);
    return item;
  }

  /* Silent write — used by background refresh so a sweep doesn't spam the UI
     with a re-render per item. Does not bump updatedAt. */
  async function putItemQuiet(item) {
    item.sortTitle = MT.util.sortTitleOf(item.title);
    normalizeIndexable(item);
    await MT.db.put('items', item);
    await writeIdIndex(item);
    return item;
  }

  /* IndexedDB cannot index arrays of objects, and booleans are not valid keys.
     Both problems are solved here, in one place, on every write. */
  function normalizeIndexable(item) {
    item.idx = item.idx || {};
    item.idx.genreIds = (item.genres || []).map(g => g.id).filter(v => v != null);
    item.idx.providerIds = collectProviderIds(item);
    const p = item.release && MT.util.sortKeyToParts(item.release.sortKey);
    item.idx.decade = p ? Math.floor(p.y / 10) * 10 : undefined;

    if (item.user) {
      item.user.tags = Array.isArray(item.user.tags) ? item.user.tags : [];
      item.user.priority = item.user.priority || 0;
      /* `rating` must be ABSENT when unrated, never 0 — the by_userRating index
         is deliberately sparse, and 0 would mean "rated zero". */
      if (item.user.rating == null || item.user.rating === '') delete item.user.rating;
    }
    if (item.tracking) {
      for (const k of ['watchReleaseFlag', 'watchEpisodesFlag', 'mutedFlag']) {
        if (typeof item.tracking[k] === 'boolean') item.tracking[k] = item.tracking[k] ? 1 : 0;
      }
    }
    if (item.facets && typeof item.facets.anime === 'boolean') {
      item.facets.anime = item.facets.anime ? 1 : 0;
    }
  }

  function collectProviderIds(item) {
    const p = item.providers;
    if (!p) return [];
    const out = new Set();
    for (const g of ['flatrate', 'free', 'ads']) {
      for (const x of (p[g] || [])) if (x && x.id != null) out.add(x.id);
    }
    return [...out];
  }

  async function deleteItem(uid) {
    const item = await getItem(uid);
    /* Recorded BEFORE the delete, so a merge can tell "I removed this" from
       "I have never seen this". */
    await MT.db.put('deleted', { uid, deletedAt: Date.now(),
                                 title: item ? item.title : null });
    await MT.db.del('items', uid);
    await MT.db.del('snapshots', uid);
    /* Cascade: leaving feed rows pointing at a deleted item produces alerts
       that navigate nowhere. */
    const rows = await MT.db.getAll('feedItems');
    for (const r of rows) if (r.uid === uid) await MT.db.del('feedItems', r.feedId);
    if (item) for (const k of idKeysFor(item)) await MT.db.del('idIndex', k);
    emit('item:delete', { uid });
  }

  function idKeysFor(item) {
    const keys = [];
    const ids = item.ids || {};
    if (ids.tmdb) keys.push(`tmdb:${ids.tmdbType || item.kind}:${ids.tmdb}`);
    if (ids.imdb) keys.push(`imdb:${ids.imdb}`);
    if (ids.rawg) keys.push(`rawg:${ids.rawg}`);
    if (ids.rawgSlug) keys.push(`rawgslug:${ids.rawgSlug}`);
    if (ids.anilist) keys.push(`anilist:${ids.anilist}`);
    return keys;
  }

  async function writeIdIndex(item) {
    for (const key of idKeysFor(item)) {
      await MT.db.put('idIndex', { key, uid: item.uid });
    }
  }

  /* Resolve any known external id to a stored uid. This is what stops the same
     film entering the library twice via search, a recommendation, and a
     followed director's credits. */
  async function resolveUid(candidateKeys) {
    for (const key of candidateKeys) {
      const hit = await MT.db.get('idIndex', key);
      if (hit) return hit.uid;
    }
    return null;
  }

  async function itemsByStatus(status) {
    const out = [];
    await MT.db.walkIndex('items', 'by_status_priority',
      IDBKeyRange.bound([status, -Infinity], [status, Infinity]),
      v => { out.push(v); });
    return out;
  }

  async function upcomingItems(limit) {
    const out = [];
    const today = MT.util.todaySortKey();
    await MT.db.walkIndex('items', 'by_releaseSort',
      IDBKeyRange.lowerBound(today),
      v => {
        if (v.user && v.user.status === 'dropped') return;
        out.push(v);
        if (limit && out.length >= limit) return false;
      });
    return out;
  }

  async function itemsDueForRefresh(limit) {
    const out = [];
    await MT.db.walkIndex('items', 'by_refreshDue',
      IDBKeyRange.upperBound(Date.now()),
      v => { out.push(v); if (limit && out.length >= limit * 4) return false; });
    return out;
  }

  /* ── Snapshots ─────────────────────────────────────────────────────── */
  const getSnapshot = uid => MT.db.get('snapshots', uid);
  const putSnapshot = s => MT.db.put('snapshots', s);

  /* ── Alerts: an append-only ledger plus a mutable feed ───────────────
     Content-addressing and coalescing cannot share one store, so they don't.
     `alertKeys` answers "have we ever seen this exact change?" and is never
     mutated. `feedItems` is what gets rendered and is merged in place. */

  async function alertSeen(alertId) {
    try {
      await MT.db.add('alertKeys', { alertId, firstSeenAt: Date.now() });
      return false;                       // newly recorded → this is news
    } catch (e) {
      if (e && e.name === 'ConstraintError') return true;   // already known
      throw e;
    }
  }

  async function pushFeedItem(row) {
    /* Coalesce into an existing UNREAD row for the same (uid, type): four date
       slips become one line reading "Nov 13 → Mar 6 (changed 4×)". */
    const existing = await MT.db.getAll('feedItems');
    const match = existing.find(r =>
      r.uid === row.uid && r.type === row.type && r.readAt == null && !r.archivedFlag);
    if (match) {
      match.to = row.to;
      match.title = row.title || match.title;
      match.count = (match.count || 1) + 1;
      match.lastAt = row.lastAt || Date.now();
      match.payload = row.payload || match.payload;
      match.severity = row.severity || match.severity;
      await MT.db.put('feedItems', match);
      emit('feed:change');
      return match;
    }
    row.feedId = row.feedId || (row.alertId || MT.util.fnv1a(`${row.uid}|${row.type}|${Date.now()}`));
    row.count = row.count || 1;
    row.firstAt = row.firstAt || Date.now();
    row.lastAt = row.lastAt || Date.now();
    row.readAt = null;
    row.readFlag = 0;                     // 0|1 — booleans are not valid keys
    row.archivedFlag = row.archivedFlag ? 1 : 0;
    await MT.db.put('feedItems', row);
    emit('feed:change');
    return row;
  }

  async function feedItems(opts) {
    opts = opts || {};
    const all = await MT.db.getAll('feedItems');
    let rows = all;
    if (!opts.includeArchived) rows = rows.filter(r => !r.archivedFlag);
    if (opts.type) rows = rows.filter(r => r.type === opts.type);
    if (opts.unreadOnly) rows = rows.filter(r => r.readAt == null);
    rows.sort((a, b) => b.lastAt - a.lastAt);
    return opts.limit ? rows.slice(0, opts.limit) : rows;
  }

  async function unreadCount() {
    const all = await MT.db.getAll('feedItems');
    return all.filter(r => r.readAt == null && !r.archivedFlag).length;
  }

  async function markFeedRead(feedIds) {
    const now = Date.now();
    for (const id of feedIds) {
      const r = await MT.db.get('feedItems', id);
      if (r && r.readAt == null) { r.readAt = now; r.readFlag = 1; await MT.db.put('feedItems', r); }
    }
    emit('feed:change');
  }

  async function markAllFeedRead() {
    const all = await MT.db.getAll('feedItems');
    const now = Date.now();
    const upd = all.filter(r => r.readAt == null).map(r => (r.readAt = now, r.readFlag = 1, r));
    await MT.db.putMany('feedItems', upd);
    emit('feed:change');
  }

  /* ── Dismissed recommendations ─────────────────────────────────────── */
  const dismiss = (uid, kind, reason, title) =>
    MT.db.put('dismissed', { uid, kind, reason: reason || 'not_interested', title, dismissedAt: Date.now() });
  const dismissedSet = async () => new Set((await MT.db.getAll('dismissed')).map(d => d.uid));
  const undismiss = uid => MT.db.del('dismissed', uid);
  const allDismissed = () => MT.db.getAll('dismissed');

  /* ── Follows ───────────────────────────────────────────────────────── */
  const allFollows = () => MT.db.getAll('follows');
  const getFollow = id => MT.db.get('follows', id);
  async function putFollow(f) { await MT.db.put('follows', f); emit('follow:change'); return f; }
  async function deleteFollow(id) { await MT.db.del('follows', id); emit('follow:change'); }

  /* ── Cache ─────────────────────────────────────────────────────────── */

  async function cacheGet(key) {
    const row = await MT.db.get('cache', key);
    if (!row) return null;
    const now = Date.now();
    if (now > row.hardExpiresAt) { MT.db.del('cache', key); return null; }
    return { payload: row.payload, stale: now > row.expiresAt, fetchedAt: row.fetchedAt };
  }

  async function cachePut(key, source, payload, ttl, cacheClass) {
    const now = Date.now();
    try {
      await MT.db.put('cache', {
        key, source, payload,
        cacheClass: cacheClass || 'reduced',
        fetchedAt: now,
        expiresAt: now + ttl,
        /* Hard ceiling is a compliance rule, not a tuning knob: TMDB's terms
           forbid retaining their data beyond six months. */
        hardExpiresAt: now + Math.min(MT.TTL.HARD_TTL, Math.max(ttl * 4, MT.TTL.HARD_TTL)),
      });
    } catch (e) { console.warn('[repo] cache write failed', e); }
  }

  async function cachePurge() {
    const now = Date.now();
    const dead = [];
    await MT.db.walkIndex('cache', 'by_hardExpiresAt', IDBKeyRange.upperBound(now),
      v => { dead.push(v.key); });
    for (const k of dead) await MT.db.del('cache', k);
    return dead.length;
  }

  const cacheClear = () => MT.db.clear('cache');
  const cacheCount = () => MT.db.count('cache');

  /* ── Document frequency (for the recommender's IDF) ─────────────────
     Every item the app ever touches contributes exactly once, ever. Without
     the dfSeen guard, re-fetching the same title on each refresh inflates DF
     monotonically and silently flattens the whole IDF curve over months. */

  async function dfObserve(uid, terms) {
    if (!uid || !terms || !terms.length) return;
    const seen = await MT.db.get('dfSeen', uid);
    if (seen) return;
    await MT.db.put('dfSeen', { uid, at: Date.now() });
    for (const t of terms) {
      const row = await MT.db.get('df', t);
      await MT.db.put('df', { term: t, n: (row ? row.n : 0) + 1 });
    }
    const n = await MT.db.count('dfSeen');
    await metaSet('df.N', n);
  }

  async function dfTable() {
    const rows = await MT.db.getAll('df');
    const map = new Map();
    for (const r of rows) map.set(r.term, r.n);
    return { map, N: (await metaGet('df.N')) || Math.max(1, map.size) };
  }

  /* ── History ───────────────────────────────────────────────────────── */
  const addHistory = (uid, event, value) => MT.db.put('history', { uid, event, value, at: Date.now() });
  const allHistory = () => MT.db.getAll('history');

  /* ── Meta ──────────────────────────────────────────────────────────── */
  async function metaGet(key) { const r = await MT.db.get('meta', key); return r ? r.value : undefined; }
  async function metaSet(key, value) { return MT.db.put('meta', { key, value }); }

  /* ── Export / import ───────────────────────────────────────────────── */

  async function exportAll() {
    const payload = {};
    for (const s of ['items', 'idIndex', 'follows', 'dismissed', 'alertKeys',
                     'feedItems', 'snapshots', 'history', 'df', 'dfSeen', 'deleted']) {
      payload[s] = await MT.db.getAll(s);
    }
    payload.meta = { settings: MT.config.exportable(), dfN: await metaGet('df.N') };
    const doc = {
      app: 'movietrak', kind: 'movietrak.export', schemaVersion: 1,
      exportedAt: new Date().toISOString(),
      counts: Object.fromEntries(Object.entries(payload)
        .filter(([, v]) => Array.isArray(v)).map(([k, v]) => [k, v.length])),
      payload,
    };
    doc.integrity = { algo: 'fnv1a', value: MT.util.fnv1a(JSON.stringify(payload)) };
    return doc;
  }

  /* Replace-only, by design. Merge semantics are a distributed-systems problem
     and there is no distributed system yet — sync is deferred.
     alertKeys IS restored: drop it and every historical change re-fires as new
     the moment you import onto a fresh browser. */
  async function importAll(doc) {
    if (!doc || doc.app !== 'movietrak') throw new Error('Not a MovieTrak export file.');
    if (doc.schemaVersion !== 1) throw new Error(`Unsupported export version ${doc.schemaVersion}.`);
    const p = doc.payload || {};
    for (const s of ['items', 'idIndex', 'follows', 'dismissed', 'alertKeys',
                     'feedItems', 'snapshots', 'history', 'df', 'dfSeen', 'deleted']) {
      await MT.db.clear(s);
      if (Array.isArray(p[s]) && p[s].length) {
        const rows = s === 'history' ? p[s].map(r => { const c = { ...r }; delete c.id; return c; }) : p[s];
        await MT.db.putMany(s, rows);
      }
    }
    if (p.meta) {
      if (p.meta.settings) MT.config.importSettings(p.meta.settings);
      if (p.meta.dfN != null) await metaSet('df.N', p.meta.dfN);
    }
    await metaSet('sync.lastImportAt', Date.now());
    emit('import:done');
    return doc.counts || {};
  }

  async function wipe() {
    for (const s of MT.db.STORE_NAMES) await MT.db.clear(s);
    emit('wipe');
  }

  return {
    subscribe, emit,
    getItem, allItems, countItems, putItem, putItemQuiet, deleteItem,
    resolveUid, idKeysFor, itemsByStatus, upcomingItems, itemsDueForRefresh,
    getSnapshot, putSnapshot,
    tombstones: () => MT.db.getAll('deleted'),
    alertSeen, pushFeedItem, feedItems, unreadCount, markFeedRead, markAllFeedRead,
    dismiss, undismiss, dismissedSet, allDismissed,
    allFollows, getFollow, putFollow, deleteFollow,
    cacheGet, cachePut, cachePurge, cacheClear, cacheCount,
    dfObserve, dfTable,
    addHistory, allHistory,
    metaGet, metaSet,
    exportAll, importAll, wipe,
  };
})();
