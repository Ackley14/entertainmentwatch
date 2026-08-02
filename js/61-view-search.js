/* ══════════════════════════════════════════════════════════════════════════
   #/search — one box across films, television and games.

   Your own index is searched first and for free; upstream is queried only
   after a pause, so typing costs at most one request per source per query.
   ══════════════════════════════════════════════════════════════════════════ */

MT.viewSearch = (function () {
  const esc = MT.util.escapeHtml;
  let inflight = null;
  let results = [];
  let cursor = -1;

  async function render(params, query) {
    const view = document.getElementById('view');
    const q = (query && query.q) || '';
    MT.ui.crumb(['Discover', 'Search']);
    MT.ui.paneActions('');

    const count = await MT.repo.countItems();
    view.innerHTML = `
      <div class="searchbox">
        <div class="sfield">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>
          </svg>
          <input id="q" type="search" placeholder="Search films, television, games…" spellcheck="false"
                 autocomplete="off" value="${esc(q)}" aria-label="Search">
        </div>
        <div class="shint">
          <kbd>⏎</kbd> add the highlighted result · <kbd>↑</kbd><kbd>↓</kbd> move ·
          searching <b>${count}</b> indexed titles, then upstream
        </div>
      </div>
      <div id="local"></div>
      <div id="remote"></div>`;

    const input = document.getElementById('q');
    const run = MT.util.debounce(() => go(input.value.trim()), 220);
    input.addEventListener('input', run);
    input.addEventListener('keydown', onKey);
    input.focus();
    if (q) go(q);
  }

  async function onKey(e) {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!results.length) return;
      cursor = e.key === 'ArrowDown' ? Math.min(results.length - 1, cursor + 1) : Math.max(0, cursor - 1);
      paintCursor();
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      const pick = results[cursor >= 0 ? cursor : 0];
      if (!pick) return;
      if (pick.owned) MT.inspector.show(pick.stub.uid);
      else { await MT.ui.addItem(pick.stub); pick.owned = true; paint(); }
    }
  }

  function paintCursor() {
    const rows = [...document.querySelectorAll('#remote tbody tr, #local tbody tr')];
    rows.forEach((r, i) => r.classList.toggle('is-sel', i === cursor));
    if (rows[cursor]) rows[cursor].scrollIntoView({ block: 'nearest' });
  }

  async function go(q) {
    const local = document.getElementById('local');
    const remote = document.getElementById('remote');
    if (!local) return;
    if (q.length < 2) { local.innerHTML = ''; remote.innerHTML = ''; results = []; return; }

    /* Local first — instant, free, and usually what you meant. */
    const all = await MT.repo.allItems();
    const needle = q.toLowerCase();
    const hits = all.filter(i =>
      i.title.toLowerCase().includes(needle) ||
      (i.originalTitle || '').toLowerCase().includes(needle)).slice(0, 12);
    local.innerHTML = hits.length
      ? MT.ui.groupHead('In your index', hits.length) + MT.ui.table(hits, MT.inspector.current)
      : '';

    if (!MT.config.hasKey('tmdb')) {
      remote.innerHTML = MT.ui.emptyState({
        title: 'No TMDB key',
        body: 'Add a free key in Settings to search beyond your own index.',
        actions: '<a class="btn btn--primary" href="#/settings">Open settings</a>',
      });
      return;
    }

    remote.innerHTML = MT.ui.groupHead('Elsewhere') + '<div class="miss muted">Searching…</div>';
    if (inflight) inflight.abort();
    inflight = new AbortController();
    const signal = inflight.signal;

    const jobs = [MT.tmdb.searchMulti(q, { signal })
      .then(rs => rs.map(r => ({ stub: MT.normalize.stubFromTmdbSearch(r), pop: r.popularity || 0 })))
      .catch(e => { if (e.kind !== 'abort') console.warn('[search] tmdb', e.message); return []; })];
    if (MT.config.hasKey('rawg')) {
      jobs.push(MT.rawg.search(q, { signal, limit: 8 })
        .then(rs => rs.map(r => ({ stub: MT.normalize.stubFromRawgSearch(r), pop: r.added || 0 })))
        .catch(() => []));
    }

    let found;
    try { found = (await Promise.all(jobs)).flat(); } catch (_) { return; }
    if (signal.aborted) return;

    const owned = new Set(all.map(i => i.uid));
    found.sort((a, b) => b.pop - a.pop);
    results = hits.map(h => ({ stub: h, owned: true }))
      .concat(found.filter(f => !owned.has(f.stub.uid)).slice(0, 20).map(f => ({ stub: f.stub, owned: false })));
    cursor = -1;
    paint();
  }

  function paint() {
    const remote = document.getElementById('remote');
    const fresh = results.filter(r => !r.owned);
    if (!fresh.length) {
      remote.innerHTML = MT.ui.groupHead('Elsewhere') +
        '<div class="miss muted">Nothing new — everything matching is already in your index.</div>';
      return;
    }
    remote.innerHTML = MT.ui.groupHead('Elsewhere', fresh.length) + fresh.map(r => `
      <div class="miss" data-add="${esc(r.stub.uid)}">
        ${MT.ui.chipart(r.stub)}
        <div style="min-width:0">
          <div style="font-weight:500">${esc(r.stub.title)}</div>
          <div class="muted" style="font-size:var(--mt-fs-mini);display:flex;gap:8px;align-items:center">
            ${MT.ui.kindTag(r.stub)} ${MT.ui.dateField(r.stub.release)}
          </div>
        </div>
        <span class="add">Add</span>
      </div>`).join('');

    remote.onclick = async e => {
      const row = e.target.closest('[data-add]');
      if (!row) return;
      const hit = results.find(r => r.stub.uid === row.dataset.add);
      if (!hit) return;
      await MT.ui.addItem(hit.stub);
      hit.owned = true;
      paint();
      MT.inspector.show(hit.stub.uid);
    };
    const local = document.getElementById('local');
    if (local) local.onclick = e => {
      const r = e.target.closest('[data-uid]');
      if (r) MT.inspector.show(r.dataset.uid);
    };
  }

  return { render };
})();
