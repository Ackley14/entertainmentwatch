/* ══════════════════════════════════════════════════════════════════════════
   Change detection.

   The app only sees the world when it is open, so "what changed" is computed
   by diffing a freshly-fetched item against a snapshot stored the last time we
   looked. Two rules make that trustworthy:

   1. COLD-SNAPSHOT RULE. If there is no previous snapshot, store one and emit
      ZERO alerts. Without it, importing a 200-item library produces 600 alerts
      on first run and the feature is dead on arrival.

   2. CONTENT-ADDRESSED IDS. An alert's identity comes from what the world
      says, never from when we noticed: fnv1a(uid|type|from|to). Two browsers
      observing the same change independently derive the same id, so merging
      exports is idempotent. Including `from` is deliberate — a genuine
      A→B→A revert produces two distinct alerts, because "the delay was
      reversed" really is news, while re-observing one transition dedupes.
   ══════════════════════════════════════════════════════════════════════════ */

MT.alerts = (function () {

  const SEVERITY = { high: 'high', normal: 'normal', low: 'low' };

  /* Only a whitelist of fields enters the snapshot. Poster art, backdrops,
     overview text, popularity and vote_average are deliberately EXCLUDED:
     they churn constantly and generate nothing anyone wants to be told. This
     single decision removes most of the false-positive surface. */
  function snapshotOf(item) {
    const rel = item.release || {};
    return {
      uid: item.uid,
      kind: item.kind,
      checkedAt: Date.now(),
      fields: {
        status: rel.status,
        precision: rel.precision,
        sortKey: rel.sortKey,
        raw: rel.raw,
        type: rel.type,
        windows: (rel.windows || []).map(w => `${w.type}:${w.region}:${w.raw}`).sort().join('|'),
        title: item.title,
        runtimeMin: item.runtimeMin,
        certification: JSON.stringify(item.certification || {}),
        seasonCount: item.tvExtra ? item.tvExtra.seasonCount : null,
        episodeCount: item.tvExtra ? item.tvExtra.episodeCount : null,
        nextEpisode: item.tvExtra && item.tvExtra.nextEpisode
          ? `${item.tvExtra.nextEpisode.season}x${item.tvExtra.nextEpisode.episode}@${item.tvExtra.nextEpisode.airDate}`
          : null,
        providers: providerFingerprint(item),
      },
    };
  }

  function providerFingerprint(item) {
    const p = item.providers;
    if (!p) return null;
    return ['flatrate', 'free', 'ads'].map(g => (p[g] || []).map(x => x.id).sort().join(',')).join('|');
  }

  function alertId(uid, type, from, to) {
    return MT.util.fnv1a(`${uid}|${type}|${from == null ? '' : from}|${to == null ? '' : to}`);
  }

  /* ── The diff ──────────────────────────────────────────────────────────
     Returns a list of candidate alerts. Persisting them (and therefore
     deduping) is `commit`'s job. */
  function diff(prev, next, item) {
    const out = [];
    if (!prev) return out;                  // cold-snapshot rule, enforced here
    const a = prev.fields, b = next.fields;

    const wasDated = a.sortKey < MT.util.SK_UNKNOWN;
    const isDated  = b.sortKey < MT.util.SK_UNKNOWN;
    const rank = { unknown: 0, tba: 0, year: 1, quarter: 2, month: 3, day: 4 };

    /* A date appearing for the first time is the single most valuable event in
       the app — the "Dune 3 finally got a date" moment. */
    if (!wasDated && isDated) {
      out.push({
        type: 'release.dated', severity: SEVERITY.high,
        from: null, to: String(b.sortKey),
        title: `${item.title} has a release date`,
        body: `${item.release.display}`,
      });
    } else if (wasDated && isDated && a.sortKey !== b.sortKey) {
      const delta = MT.util.daysBetweenSortKeys(a.sortKey, b.sortKey);
      out.push({
        type: 'release.moved',
        severity: Math.abs(delta || 0) >= 14 ? SEVERITY.high : SEVERITY.normal,
        from: String(a.sortKey), to: String(b.sortKey),
        title: `${item.title} moved`,
        body: `${fmtKey(a.sortKey)} → ${fmtKey(b.sortKey)}`,
        payload: { deltaDays: delta },
      });
    } else if (wasDated && !isDated) {
      /* Date REMOVALS are usually vandalism or a data-entry artifact, so they
         require two consecutive observations before they surface. See
         `pendingConfirm` below — asymmetric on purpose. */
      out.push({
        type: 'release.pulled', severity: SEVERITY.normal, needsConfirm: true,
        from: String(a.sortKey), to: null,
        title: `${item.title} lost its release date`,
        body: 'The date was removed upstream.',
      });
    } else if (isDated && (rank[b.precision] || 0) > (rank[a.precision] || 0)) {
      /* Precision INCREASES alert immediately: high value, low false-positive
         rate, and this is the closest legitimate proxy for "tickets soon". */
      out.push({
        type: 'release.precision', severity: SEVERITY.normal,
        from: `${a.precision}:${a.sortKey}`, to: `${b.precision}:${b.sortKey}`,
        title: `${item.title} — date firmed up`,
        body: `Now ${item.release.display}`,
      });
    }

    if (a.status !== b.status) {
      const advancing = (MT.normalize.STATUS_RANK[b.status] || 0) >= (MT.normalize.STATUS_RANK[a.status] || 0);
      if (b.status === 'cancelled') {
        out.push({ type: 'status.cancelled', severity: SEVERITY.high,
          from: a.status, to: b.status,
          title: `${item.title} was cancelled`, body: '' });
      } else {
        out.push({
          type: 'status.changed',
          severity: SEVERITY.low,
          /* A regression (Released → Post Production) is almost always bad
             data, so it waits for confirmation. */
          needsConfirm: !advancing,
          from: a.status, to: b.status,
          title: `${item.title} is now ${prettyStatus(b.status)}`, body: '',
        });
      }
    }

    if (item.kind === 'tv') {
      if (a.seasonCount != null && b.seasonCount > a.seasonCount) {
        out.push({ type: 'season.new', severity: SEVERITY.high,
          from: String(a.seasonCount), to: String(b.seasonCount),
          title: `${item.title} — season ${b.seasonCount}`, body: '' });
      }
      if (a.nextEpisode !== b.nextEpisode && b.nextEpisode) {
        const nx = item.tvExtra.nextEpisode;
        out.push({ type: 'episode.next', severity: SEVERITY.low,
          from: a.nextEpisode, to: b.nextEpisode,
          title: `${item.title} ${nx.season}×${String(nx.episode).padStart(2, '0')}`,
          body: nx.name ? `“${nx.name}” — ${nx.airDate}` : nx.airDate });
      }
    }

    if (a.providers !== b.providers && b.providers) {
      const added = newProviders(prev, next, item);
      if (added.length) {
        out.push({ type: 'provider.added', severity: SEVERITY.normal,
          from: a.providers, to: b.providers,
          title: `${item.title} is now streaming`,
          body: `On ${added.map(p => p.name).join(', ')}`,
          payload: { providers: added.map(p => p.id) } });
      }
    }

    return out;
  }

  function newProviders(prev, next, item) {
    const before = new Set(String(prev.fields.providers || '').split(/[,|]/).filter(Boolean));
    const p = item.providers || {};
    const out = [];
    for (const g of ['flatrate', 'free', 'ads']) {
      for (const x of (p[g] || [])) if (!before.has(String(x.id))) out.push(x);
    }
    void next;
    return MT.util.uniqBy(out, x => x.id);
  }

  function prettyStatus(s) {
    return ({ unannounced: 'rumoured', announced: 'announced', in_production: 'filming',
              post_production: 'in post-production', released: 'released',
              ongoing: 'airing', ended: 'ended', cancelled: 'cancelled' })[s] || s;
  }

  function fmtKey(sk) {
    const p = MT.util.sortKeyToParts(sk);
    return p ? MT.util.displayRelease(p, 'day') : 'no date';
  }

  /* ── Commit ────────────────────────────────────────────────────────────
     Snapshot, ledger insert and feed upsert happen together per item, so a tab
     closed mid-sweep loses at most one item's work — and a snapshot can never
     advance past an alert that was not persisted. */
  async function commit(item, candidates, nextSnapshot) {
    const emitted = [];
    for (const c of candidates) {
      const id = alertId(item.uid, c.type, c.from, c.to);

      /* Asymmetric confirmation: suspicious transitions must be seen twice. */
      if (c.needsConfirm) {
        const pendKey = 'pending:' + id;
        const seenBefore = await MT.repo.metaGet(pendKey);
        if (!seenBefore) { await MT.repo.metaSet(pendKey, Date.now()); continue; }
      }

      const known = await MT.repo.alertSeen(id);
      if (known) continue;

      /* Anything whose subject is already well in the past is archived on
         ingest. "Tickets went on sale six weeks ago" is not news, and showing
         it is worse than dropping it. */
      const subjectKey = Number(c.to);
      const stale = Number.isFinite(subjectKey) && subjectKey < MT.util.SK_UNKNOWN &&
                    MT.util.daysUntil(subjectKey) < -30;

      const row = await MT.repo.pushFeedItem({
        alertId: id, uid: item.uid, kind: item.kind, type: c.type,
        severity: c.severity || SEVERITY.normal,
        title: c.title, body: c.body || '',
        from: c.from, to: c.to,
        posterPath: item.images && item.images.posterPath,
        payload: c.payload || null,
        archivedFlag: stale ? 1 : 0,
        lastAt: Date.now(),
      });
      emitted.push(row);
    }
    await MT.repo.putSnapshot(nextSnapshot);
    return emitted;
  }

  /* Full check for one item: snapshot → diff → commit. */
  async function checkItem(item) {
    const prev = await MT.repo.getSnapshot(item.uid);
    const next = snapshotOf(item);
    if (!prev) {                              // cold-snapshot rule
      await MT.repo.putSnapshot(Object.assign({ baseline: 1 }, next));
      return [];
    }
    const candidates = diff(prev, next, item);
    return commit(item, candidates, next);
  }

  /* ── Local scan ────────────────────────────────────────────────────────
     Purely date arithmetic against what is already stored — zero network. This
     is what makes "it released today" fire even when the app has been offline
     for a week. */
  async function scanLocal() {
    const today = MT.util.todaySortKey();
    const items = await MT.repo.allItems();
    const out = [];

    for (const item of items) {
      if (!item.tracking || item.tracking.mutedFlag || !item.tracking.watchReleaseFlag) continue;
      if (item.user && (item.user.status === 'watched' || item.user.status === 'dropped')) continue;
      const rel = item.release;
      if (!rel || rel.sortKey >= MT.util.SK_UNKNOWN) continue;

      const days = MT.util.daysUntil(rel.sortKey);

      if (days === 0) {
        const id = alertId(item.uid, 'release.today', null, String(rel.sortKey));
        if (!(await MT.repo.alertSeen(id))) {
          out.push(await MT.repo.pushFeedItem({
            alertId: id, uid: item.uid, kind: item.kind, type: 'release.today',
            severity: SEVERITY.high,
            title: `${item.title} is out today`,
            body: rel.type === 'game_launch' ? 'Released today.' : `${prettyType(rel.type)} today.`,
            posterPath: item.images && item.images.posterPath,
            to: String(rel.sortKey), lastAt: Date.now(),
          }));
        }
      } else if (days > 0 && days <= 7 && rel.precision === 'day') {
        const id = alertId(item.uid, 'release.soon', null, String(rel.sortKey));
        if (!(await MT.repo.alertSeen(id))) {
          out.push(await MT.repo.pushFeedItem({
            alertId: id, uid: item.uid, kind: item.kind, type: 'release.soon',
            severity: SEVERITY.normal,
            title: `${item.title} — ${MT.util.relativeDays(days)}`,
            body: rel.display,
            posterPath: item.images && item.images.posterPath,
            to: String(rel.sortKey), lastAt: Date.now(),
          }));
        }
      }

      /* The honest ticket signal. There is no free, CORS-open API for cinema
         on-sale dates anywhere, so this is explicitly framed as a heuristic
         about the release date, NOT a claim that tickets are on sale. Saying
         "tickets on sale now" and being wrong once would kill the feature. */
      if (item.kind === 'movie' && days > 14 && days <= 35 &&
          rel.precision === 'day' && rel.type === 'theatrical') {
        const id = alertId(item.uid, 'release.tickets_window', null, String(rel.sortKey));
        if (!(await MT.repo.alertSeen(id))) {
          out.push(await MT.repo.pushFeedItem({
            alertId: id, uid: item.uid, kind: item.kind, type: 'release.tickets_window',
            severity: SEVERITY.low,
            title: `${item.title} — booking window approaching`,
            body: `Release date locked for ${rel.display}. Cinema tickets typically open around three weeks out; MovieTrak has no ticketing integration, so check your cinema.`,
            posterPath: item.images && item.images.posterPath,
            to: String(rel.sortKey), lastAt: Date.now(),
          }));
        }
      }
    }
    return out;
  }

  function prettyType(t) {
    return ({ theatrical: 'In cinemas', limited: 'Limited release', digital: 'Streaming',
              physical: 'On disc', tv: 'On air', game_launch: 'Released' })[t] || 'Out';
  }

  /* ── Follows ───────────────────────────────────────────────────────────
     Polling a followed PERSON rather than each tracked item is what makes
     undated projects discoverable at all: one combined_credits call covers
     every unreleased film a director is attached to, including ones not yet in
     the library — and /discover cannot see them, because it has no status
     filter and anchors every query on dates. */
  async function checkFollow(follow) {
    if (follow.muted) return [];
    let credits;
    try {
      credits = follow.type === 'company'
        ? { cast: [], crew: await MT.tmdb.companyReleases(follow.sourceId) }
        : await MT.tmdb.personCredits(follow.sourceId, { fresh: true });
    } catch (e) {
      console.warn('[alerts] follow check failed', follow.name, e && e.message);
      return [];
    }

    const works = []
      .concat(credits.cast || [])
      .concat(credits.crew || [])
      .filter(w => w && w.id && (w.media_type === 'movie' || w.media_type === 'tv' || !w.media_type));

    const known = new Set(follow.knownWorkIds || []);
    const out = [];
    const nowIds = [];

    for (const w of works) {
      const kind = w.media_type === 'tv' ? 'tv' : 'movie';
      const key = `${kind}:${w.id}`;
      nowIds.push(key);
      if (known.has(key)) continue;
      if (!known.size) continue;              // first sight of this follow = baseline

      const title = w.title || w.name;
      const dateStr = w.release_date || w.first_air_date;
      const rel = MT.normalize.buildRelease(dateStr, {});
      const id = alertId(`follow:${follow.id}`, 'person.newProject', null, key);
      if (await MT.repo.alertSeen(id)) continue;

      out.push(await MT.repo.pushFeedItem({
        alertId: id, uid: MT.normalize.uidOf(kind, 'tmdb', w.id), kind, type: 'person.newProject',
        severity: SEVERITY.high,
        title: `${follow.name}: ${title}`,
        body: rel.sortKey < MT.util.SK_UNKNOWN
          ? `New project — ${rel.display}`
          : 'New project — no date yet',
        posterPath: w.poster_path || null,
        to: key, lastAt: Date.now(),
        payload: { followId: follow.id, tmdbId: w.id, tmdbKind: kind },
      }));
    }

    follow.knownWorkIds = nowIds;
    follow.lastCheckedAt = Date.now();
    await MT.repo.putFollow(follow);
    return out;
  }

  return {
    snapshotOf, diff, commit, checkItem, scanLocal, checkFollow, alertId,
    prettyStatus, prettyType, SEVERITY,
  };
})();
