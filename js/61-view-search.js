/* ══════════════════════════════════════════════════════════════════════════
   #/search — tabbed search across films, television, games and anime.

   Two things this file is careful about:

   1. RELEVANCE. Providers rank by their own popularity metric and those
      metrics are not comparable: TMDB's popularity for "Practical Magic" is
      7.9, RAWG's `added` for "Magic: The Gathering" is 226. Sorting one merged
      list by "popularity" therefore put every game above every film. RAWG's
      search is also loose enough to answer "practical magic" with half a dozen
      games containing no "practical" at all. So ordering is done by
      MT.util.rankByRelevance, which scores the query against the title and
      demotes the provider's own number to a tiebreak within a band.

   2. COST. Each tab queries only the sources it needs, and the results are
      cached per (tab, query) for the session so flipping between tabs after
      one search is free.
   ══════════════════════════════════════════════════════════════════════════ */

MT.viewSearch = (function () {
  const esc = MT.util.escapeHtml;
  const TAB_KEY = 'mt.search.tab';

  const TABS = [
    { id: 'all',   label: 'All' },
    { id: 'movie', label: 'Films' },
    { id: 'tv',    label: 'TV' },
    { id: 'game',  label: 'Games' },
    { id: 'anime', label: 'Anime' },
  ];

  let inflight = null;
  const cache = new Map();          // `${tab}\n${query}` -> rows
  let rows = [];
  let cursor = -1;
  let lastFailed = [];
  let query = '';
  let tab = 'all';
  let touchStart = null;
  let moved = false;

  /* True when the click we are handling is the tail of a scroll gesture. */
  function suppressTap() {
    if (!moved) return false;
    moved = false;
    return true;
  }

  const tabOf = () => { try { return localStorage.getItem(TAB_KEY) || 'all'; } catch (_) { return 'all'; } };
  const setTab = t => { try { localStorage.setItem(TAB_KEY, t); } catch (_) {} };

  async function render(params, q) {
    const view = document.getElementById('view');
    query = (q && q.q) || '';
    tab = (q && q.tab) || tabOf();
    MT.ui.crumb(['Discover', 'Search']);
    MT.ui.paneActions('');

    const count = await MT.repo.countItems();
    view.innerHTML = `
      <div class="searchbox">
        <div class="sfield">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>
          </svg>
          <input id="q" type="search" placeholder="Search by title…" spellcheck="false"
                 autocomplete="off" autocapitalize="none" autocorrect="off" enterkeyhint="search"
                 value="${esc(query)}" aria-label="Search">
        </div>
        <div class="shint">
          <kbd>⏎</kbd> add the highlighted result · <kbd>↑</kbd><kbd>↓</kbd> move ·
          <b>${count}</b> already indexed
        </div>
      </div>

      <div class="toolbar" role="tablist" aria-label="Category">
        <div class="chips" id="searchTabs">
          ${TABS.map(t => `<button class="chip" type="button" role="tab" data-tab="${t.id}"
             aria-selected="${t.id === tab}" aria-pressed="${t.id === tab}">${t.label}<span class="count" data-n="${t.id}"></span></button>`).join('')}
        </div>
        <div class="spacer"></div>
        <span class="count" id="srcNote"></span>
      </div>

      <div id="results"></div>`;

    const input = document.getElementById('q');
    /* Longer on touch: thumb typing has bigger inter-key gaps, so a desktop
       debounce fires mid-word and throws away the request a moment later. */
    const wait = matchMedia('(pointer: coarse)').matches ? 320 : 240;
    const run = MT.util.debounce(() => go(input.value.trim()), wait);
    input.addEventListener('input', run);
    input.addEventListener('keydown', onKey);

    document.getElementById('searchTabs').addEventListener('click', e => {
      const b = e.target.closest('[data-tab]');
      if (!b || b.dataset.tab === tab) return;
      tab = b.dataset.tab;
      setTab(tab);
      for (const x of document.querySelectorAll('#searchTabs [data-tab]')) {
        const on = x.dataset.tab === tab;
        x.setAttribute('aria-selected', on);
        x.setAttribute('aria-pressed', on);
      }
      go(query, { keepFocus: true });
    });

    /* Don't steal focus on a phone — an auto-opening keyboard on arrival is
       hostile when you got here from the index rather than to type. */
    if (!matchMedia('(pointer: coarse)').matches) input.focus();
    if (query) go(query);
    else showIdle();
  }

  function showIdle() {
    const host = document.getElementById('results');
    if (host) host.innerHTML = MT.ui.emptyState({
      title: 'Search by title',
      body: 'Pick a category above to search it directly, or leave it on All. Films and television come from TMDB, games from RAWG.',
    });
  }

  async function onKey(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!rows.length) return;
      cursor = e.key === 'ArrowDown' ? Math.min(rows.length - 1, cursor + 1) : Math.max(0, cursor - 1);
      paintCursor();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const pick = rows[cursor >= 0 ? cursor : 0];
      if (!pick) return;
      if (pick.owned) MT.inspector.show(pick.stub.uid);
      else { await MT.ui.addItem(pick.stub); pick.owned = true; paint(); }
    }
  }

  function paintCursor() {
    const els = [...document.querySelectorAll('#results .miss')];
    els.forEach((r, i) => r.classList.toggle('is-sel', i === cursor));
    if (els[cursor]) els[cursor].scrollIntoView({ block: 'nearest' });
  }

  /* ── Fetching ─────────────────────────────────────────────────────────── */

  async function go(q, opts) {
    void (opts || {});
    query = q;
    const host = document.getElementById('results');
    if (!host) return;
    if (q.length < 2) { rows = []; host.classList.remove('is-stale'); showIdle(); clearCounts(); return; }

    const key = tab + '\n' + q.toLowerCase();
    if (cache.has(key)) { rows = cache.get(key); cursor = -1; paint(); return; }

    /* Only show skeletons when there is nothing to keep. Replacing a full
       result list with skeletons on every keystroke collapses the list height
       and springs it back, which is what made typing feel jerky on a phone.
       With results already on screen, mark them stale instead and swap in
       place when the new ones land — the list never changes height mid-type. */
    if (!rows.length) host.innerHTML = MT.ui.skeletonGrid(4);
    else host.classList.add('is-stale');

    if (inflight) inflight.abort();
    inflight = new AbortController();
    const signal = inflight.signal;

    let raw;
    const failed = [];
    try { raw = await fetchFor(tab, q, signal, failed); }
    catch (e) {
      if (e && e.kind === 'abort') return;
      host.innerHTML = MT.ui.errorBox('Search failed', e.message || String(e));
      return;
    }
    if (signal.aborted) return;

    /* Score against the query, not against whatever each provider thinks is
       popular. This is what stops "Magic: The Gathering" answering
       "practical magic". */
    const ranked = MT.util.rankByRelevance(q, raw);

    const owned = new Map();
    for (const it of await MT.repo.allItems()) owned.set(it.uid, it.user.status);

    rows = ranked.map(r => ({ stub: r.stub, owned: owned.get(r.stub.uid) || null, score: r._score }));
    lastFailed = failed;
    /* A result set that is short because a provider was unreachable must not be
       cached as if it were the real answer — the next search for the same
       words would then serve the gap back with no explanation. */
    if (!failed.length) cache.set(key, rows);
    else cache.delete(key);
    cursor = -1;
    host.classList.remove('is-stale');
    paint();
    /* NOTHING here may touch the input's value or selection. An earlier
       version moved the caret to the end of the query it had STARTED with,
       which lands mid-word if you kept typing during the fetch — so the next
       keystrokes insert at the wrong offset and the word comes out scrambled
       ("the dog stars" -> "gthe do stars"). The caret is already where the
       user put it; leave it alone. */
  }

  /* Each tab pays only for what it shows. */
  async function fetchFor(which, q, signal, failed) {
    const out = [];
    const wantTmdb = which !== 'game';
    const wantRawg = which === 'all' || which === 'game';

    const jobs = [];
    if (wantTmdb && MT.config.hasKey('tmdb')) {
      if (which === 'all' || which === 'anime') {
        jobs.push(MT.tmdb.searchMulti(q, { signal }).catch(swallowInto(failed, 'TMDB')));
      } else {
        jobs.push(MT.tmdb.searchKind(which, q, { signal }).catch(swallowInto(failed, 'TMDB')));
      }
    }
    if (wantRawg && MT.config.hasKey('rawg')) {
      jobs.push(MT.rawg.search(q, { signal, limit: 12 })
        .then(rs => rs.map(r => ({ __rawg: true, ...r }))).catch(swallowInto(failed, 'RAWG')));
    }
    if (!jobs.length) {
      throw new MT.net.NetError('auth',
        which === 'game' ? 'Add a free RAWG key in Settings to search games.'
                         : 'Add a free TMDB key in Settings to search.', { setup: true });
    }

    for (const r of (await Promise.all(jobs)).flat()) {
      if (r.__rawg) {
        const stub = MT.normalize.stubFromRawgSearch(r);
        out.push({ stub, title: stub.title, originalTitle: r.name_original, pop: normPop('rawg', r.added) });
      } else {
        const stub = MT.normalize.stubFromTmdbSearch(r);
        /* Anime is a facet, not a kind: TMDB search results carry genre_ids,
           so animation + Japanese origin is the same test the normalizer uses
           on a full record. */
        if (which === 'anime') {
          const animated = (r.genre_ids || []).includes(16);
          const jp = r.original_language === 'ja' || (r.origin_country || []).includes('JP');
          if (!animated || !jp) continue;
          stub.facets = { anime: 1 };
        }
        out.push({ stub, title: stub.title, originalTitle: stub.originalTitle, pop: normPop('tmdb', r.popularity) });
      }
    }
    return out;
  }

  /* A provider that is DOWN and a provider that found nothing are different
     facts, and collapsing them is why a RAWG outage rendered as
     "Nothing matching Elden Ring" — which is simply untrue and sends you off
     to check your spelling.

     Failures are still swallowed rather than thrown, because on the All tab a
     dead RAWG must not take the film results with it. They are recorded so the
     view can say what happened. */
  function swallowInto(failed, source) {
    return e => {
      if (e && e.kind === 'abort') return [];
      console.warn('[search]', source, e && e.message);
      failed.push({ source, kind: (e && e.kind) || 'server', message: (e && e.message) || String(e) });
      return [];
    };
  }

  /* Squash each provider's popularity onto a common 0..1 scale so it can act
     as a tiebreak without one source's larger numbers dominating. */
  function normPop(source, v) {
    const n = Number(v) || 0;
    if (source === 'rawg') return Math.min(1, Math.log10(n + 1) / 5);      // `added`, 0..~100k
    return Math.min(1, Math.log10(n + 1) / 3);                             // popularity, 0..~1000
  }

  /* ── Painting ─────────────────────────────────────────────────────────── */

  function clearCounts() {
    for (const el of document.querySelectorAll('#searchTabs [data-n]')) el.textContent = '';
    const s = document.getElementById('srcNote'); if (s) s.textContent = '';
  }

  function paint() {
    const host = document.getElementById('results');
    if (!host) return;

    const n = document.querySelector(`#searchTabs [data-n="${tab}"]`);
    clearCounts();
    if (n) n.textContent = rows.length ? ` ${rows.length}` : '';
    const src = document.getElementById('srcNote');
    if (src) src.textContent = tab === 'game' ? 'RAWG' : tab === 'all' ? 'TMDB · RAWG' : 'TMDB';

    if (!rows.length) {
      /* Nothing found AND a provider was down: the honest answer is that we do
         not know, not that there are no matches. */
      if (lastFailed.length) {
        const f = lastFailed[0];
        const offline = lastFailed.some(x => x.kind === 'offline');
        host.innerHTML = MT.ui.errorBox(
          offline ? 'You appear to be offline'
                  : `${f.source} is not answering`,
          offline
            ? 'Search needs a connection. Your library still works offline.'
            : `${f.message} Nothing can be searched here until it is back — this is not a `
              + 'statement about whether the title exists.');
        return;
      }
      host.innerHTML = MT.ui.emptyState({
        title: `Nothing matching “${esc(query)}”`,
        body: tab === 'all'
          ? 'Try fewer words, or the original-language title.'
          : `Nothing in ${TABS.find(t => t.id === tab).label}. Try the All tab, or a different category.`,
      });
      return;
    }

    /* Results, but partial: say which half is missing rather than quietly
       showing films only when games were asked for too. */
    const partial = lastFailed.length
      ? `<div class="relstale">${esc(lastFailed[0].source)} is not answering, so
           ${lastFailed[0].source === 'RAWG' ? 'games are' : 'films and television are'}
           missing from these results.</div>`
      : '';

    const mine = rows.filter(r => r.owned);
    const fresh = rows.filter(r => !r.owned);

    const html = partial +
      (mine.length ? MT.ui.groupHead('Already in your index', mine.length) + mine.map(row).join('') : '') +
      (fresh.length ? MT.ui.groupHead('Results', fresh.length) + fresh.map(row).join('') : '');
    /* Skip the write when nothing changed — otherwise every paint re-creates
       the poster <img> elements and they flash as they re-decode. */
    if (host.dataset.sig !== html.length + ':' + rows.length) {
      host.innerHTML = html;
      host.dataset.sig = html.length + ':' + rows.length;
    }

    /* Adding is deliberate: only the Add button adds. Tapping the row opens
       the inspector, which is safe and reversible. The row used to carry the
       add handler itself, so a scroll that ended in a tap silently added
       whatever was under your thumb. */
    host.onclick = async e => {
      const addBtn = e.target.closest('[data-add]');
      if (addBtn) {
        if (suppressTap()) return;
        const hit = rows.find(r => r.stub.uid === addBtn.dataset.add);
        if (!hit || hit.owned) return;
        await MT.ui.addItem(hit.stub);
        hit.owned = 'want';
        host.dataset.sig = '';           // force a repaint of the button state
        paint();
        return;
      }
      const el = e.target.closest('[data-uid]');
      if (!el || suppressTap()) return;
      const hit = rows.find(r => r.stub.uid === el.dataset.uid);
      if (hit) MT.inspector.show(hit.stub.uid);
    };

    /* A tap that follows finger movement is a scroll, not a tap. Browsers
       still fire click after a short drag, which on a dense list means a flick
       can land on whatever was underneath. */
    host.ontouchstart = e => {
      const t = e.touches[0];
      touchStart = { x: t.clientX, y: t.clientY, at: Date.now() };
      moved = false;
    };
    host.ontouchmove = e => {
      if (!touchStart) return;
      const t = e.touches[0];
      if (Math.abs(t.clientY - touchStart.y) > 8 || Math.abs(t.clientX - touchStart.x) > 8) moved = true;
    };

    paintCursor();
  }

  function row(r) {
    const s = r.stub;
    return `<div class="miss" data-uid="${esc(s.uid)}">
      ${MT.ui.chipart(s)}
      <div style="min-width:0;flex:1">
        <div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.title)}</div>
        <div class="muted" style="font-size:var(--mt-fs-mini);display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          ${MT.ui.kindTag(s)} ${MT.ui.dateField(s.release)}
        </div>
      </div>
      ${r.owned
        ? `<span class="add is-in">✓ ${MT.ui.STATUS_WORD[r.owned] || 'In index'}</span>`
        : `<button class="add" type="button" data-add="${esc(s.uid)}" aria-label="Add ${esc(s.title)}">Add</button>`}
    </div>`;
  }

  return { render };
})();
