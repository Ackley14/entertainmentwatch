/* ══════════════════════════════════════════════════════════════════════════
   Search — the omnibox in the header plus the full #/search screen.

   This is the path that matters most: "type a title, press Enter, it's on the
   list." Everything here is arranged around keeping that under three
   keystrokes and never making it wait on the network to feel done.

   One search box across every medium rather than scoped tabs, because
   choosing a tab before you've typed is a decision the app can make for you:
   TMDB's /search/multi covers film and television in one request, and RAWG is
   queried in parallel only when a games key exists.
   ══════════════════════════════════════════════════════════════════════════ */

MT.viewSearch = (function () {
  const esc = MT.util.escapeHtml;
  let inflight = null;
  let lastResults = [];
  let cursor = -1;

  function init() {
    const input = document.getElementById('omni');
    const pop = document.getElementById('omni-pop');

    const run = MT.util.debounce(async () => {
      const q = input.value.trim();
      if (q.length < 2) { closePop(); return; }
      await search(q, pop, input);
    }, 180);

    input.addEventListener('input', run);
    input.addEventListener('focus', () => { if (lastResults.length && input.value.trim().length >= 2) openPop(); });

    input.addEventListener('keydown', async e => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        if (!lastResults.length) return;
        cursor = e.key === 'ArrowDown'
          ? Math.min(lastResults.length - 1, cursor + 1)
          : Math.max(0, cursor - 1);
        paint(pop, input.value.trim());
        const sel = pop.querySelector('[aria-selected="true"]');
        if (sel) sel.scrollIntoView({ block: 'nearest' });
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        /* Enter with nothing highlighted adds the top hit. That is the whole
           "three keystrokes" claim: type, maybe arrow, Enter. */
        const pick = lastResults[cursor >= 0 ? cursor : 0];
        if (pick) {
          await addFromResult(pick);
          input.value = ''; closePop();
        } else if (input.value.trim()) {
          MT.router.go('#/search?q=' + encodeURIComponent(input.value.trim()));
        }
        return;
      }
      if (e.key === 'Escape') { closePop(); input.blur(); }
    });

    pop.addEventListener('click', async e => {
      const addBtn = e.target.closest('[data-add]');
      const row = e.target.closest('.row');
      if (addBtn) {
        e.preventDefault(); e.stopPropagation();
        const hit = lastResults.find(r => r.stub.uid === addBtn.dataset.add);
        if (hit) { await addFromResult(hit); paint(pop, input.value.trim()); }
        return;
      }
      if (row) {
        const hit = lastResults.find(r => r.stub.uid === row.dataset.uid);
        if (hit) {
          if (!hit.inLibrary) await addFromResult(hit);
          closePop();
          MT.router.go('#/item/' + encodeURIComponent(hit.stub.uid));
        }
      }
    });

    document.addEventListener('click', e => {
      if (!e.target.closest('.omni')) closePop();
    });

    function openPop() { pop.hidden = false; document.getElementById('omni').setAttribute('aria-expanded', 'true'); }
    function closePop() { pop.hidden = true; cursor = -1; document.getElementById('omni').setAttribute('aria-expanded', 'false'); }

    MT.viewSearch._openPop = openPop;
    MT.viewSearch._closePop = closePop;
    MT.viewSearch._paint = paint;
  }

  async function addFromResult(hit) {
    const item = await MT.ui.addItem(hit.stub, { source: 'search' });
    hit.inLibrary = item.user.status;
    return item;
  }

  /* Query every configured source concurrently. A source that is missing a key
     or is down contributes nothing and is not an error — the results just come
     from fewer places. */
  async function search(q, pop, input) {
    if (inflight) inflight.abort();
    inflight = new AbortController();
    const signal = inflight.signal;

    pop.innerHTML = '<div class="row__group">Searching…</div>';
    MT.viewSearch._openPop();

    const jobs = [];
    if (MT.config.hasKey('tmdb')) {
      jobs.push(MT.tmdb.searchMulti(q, { signal })
        .then(rs => rs.map(r => ({ stub: MT.normalize.stubFromTmdbSearch(r), pop: r.popularity || 0 })))
        .catch(e => { if (e.kind !== 'abort') console.warn('[search] tmdb', e.message); return []; }));
    }
    if (MT.config.hasKey('rawg')) {
      jobs.push(MT.rawg.search(q, { signal, limit: 8 })
        .then(rs => rs.map(r => ({ stub: MT.normalize.stubFromRawgSearch(r), pop: r.added || 0 })))
        .catch(e => { if (e.kind !== 'abort') console.warn('[search] rawg', e.message); return []; }));
    }

    if (!jobs.length) {
      pop.innerHTML = `<div class="row"><div class="row__main">
        <div class="row__title">No API key yet</div>
        <div class="row__meta">Add a free TMDB key in Settings to start searching.</div>
      </div><div class="row__act"><a class="btn btn--sm" href="#/settings">Settings</a></div></div>`;
      return;
    }

    let results;
    try { results = (await Promise.all(jobs)).flat(); }
    catch (e) { return; }
    if (signal.aborted) return;

    const owned = new Map();
    for (const it of await MT.repo.allItems()) owned.set(it.uid, it.user.status);

    results.sort((a, b) => b.pop - a.pop);
    lastResults = results.slice(0, MT.LIMITS.searchResults).map(r => ({
      stub: r.stub, inLibrary: owned.get(r.stub.uid) || null,
    }));
    cursor = -1;
    paint(pop, q);
    void input;
  }

  function paint(pop, q) {
    if (!lastResults.length) {
      pop.innerHTML = `<div class="row"><div class="row__main">
        <div class="row__title">No matches for “${esc(q)}”</div>
        <div class="row__meta">Try the original-language title, or check spelling.</div>
      </div></div>`;
      return;
    }
    const groups = { movie: [], tv: [], game: [] };
    lastResults.forEach((r, i) => groups[r.stub.kind].push({ r, i }));

    let html = '';
    for (const [kind, label] of [['movie', 'Films'], ['tv', 'Television'], ['game', 'Games']]) {
      if (!groups[kind].length) continue;
      html += `<div class="row__group"><span>${label}</span><span>${groups[kind].length}</span></div>`;
      for (const { r, i } of groups[kind]) {
        html += MT.ui.resultRow(r.stub, { selected: i === cursor, inLibrary: r.inLibrary });
      }
    }
    html += `<div class="row__group" style="position:static">
      <span>Press <span class="num">Enter</span> to add the highlighted result</span>
      <a href="#/search?q=${encodeURIComponent(q)}">See all →</a></div>`;
    pop.innerHTML = html;
  }

  /* ── The full-page version ─────────────────────────────────────────── */
  async function render(params, query) {
    const view = document.getElementById('view');
    const q = (query && query.q) || '';

    view.innerHTML = `
      <div class="pagehead">
        <div>
          <h1>Search</h1>
          <div class="pagehead__sub">${q ? `Results for “${esc(q)}”` : 'Find something to watch or play'}</div>
        </div>
      </div>
      <div id="search-results">${q ? MT.ui.skeletonGrid(8) : MT.ui.emptyState({
        title: 'What are you looking for?',
        body: 'Use the box at the top — it searches films, television and games at once. Press <span class="num">/</span> from anywhere to jump to it.',
      })}</div>`;

    if (!q) return;
    if (!MT.config.hasKey('tmdb')) {
      document.getElementById('search-results').innerHTML = MT.ui.emptyState({
        title: 'No TMDB key yet',
        body: 'MovieTrak needs a free TMDB key to search. It takes about a minute.',
        actions: '<a class="btn btn--primary" href="#/settings">Open settings</a>',
      });
      return;
    }

    const jobs = [MT.tmdb.searchMulti(q).then(rs => rs.map(MT.normalize.stubFromTmdbSearch)).catch(() => [])];
    if (MT.config.hasKey('rawg')) {
      jobs.push(MT.rawg.search(q, { limit: 12 }).then(rs => rs.map(MT.normalize.stubFromRawgSearch)).catch(() => []));
    }
    const stubs = (await Promise.all(jobs)).flat();
    const owned = new Map();
    for (const it of await MT.repo.allItems()) owned.set(it.uid, it.user.status);

    const host = document.getElementById('search-results');
    if (!stubs.length) {
      host.innerHTML = MT.ui.emptyState({ title: `Nothing found for “${esc(q)}”`,
        body: 'Try the original-language title, or a different spelling.' });
      return;
    }

    host.innerHTML = '<div class="grid">' + stubs.map(s => MT.ui.posterCard(
      owned.has(s.uid) ? Object.assign({}, s, { user: { status: owned.get(s.uid) } }) : s,
      { extra: owned.has(s.uid) ? '' : `<button class="btn btn--sm" data-add="${esc(s.uid)}">Add</button>` }
    )).join('') + '</div>';

    host.addEventListener('click', async e => {
      const btn = e.target.closest('[data-add]');
      if (!btn) return;
      e.preventDefault(); e.stopPropagation();
      const stub = stubs.find(s => s.uid === btn.dataset.add);
      if (stub) { await MT.ui.addItem(stub); btn.outerHTML = '<span class="row__in">✓ Added</span>'; }
    });
  }

  return { init, render };
})();
