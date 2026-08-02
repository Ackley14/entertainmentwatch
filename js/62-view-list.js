/* ══════════════════════════════════════════════════════════════════════════
   #/library — the dense default view. Table or poster grid.
   ══════════════════════════════════════════════════════════════════════════ */

MT.viewLibrary = (function () {
  const esc = MT.util.escapeHtml;
  const MODE_KEY = 'mt.library.mode';

  /* The order types are shown in. Matches the filter chips and the index tree,
     so the same four things appear in the same sequence wherever you look. */
  const KIND_ORDER = ['film', 'tv', 'game', 'anime'];
  const kindRank = it => {
    const i = KIND_ORDER.indexOf(MT.ui.kindOf(it));
    return i < 0 ? KIND_ORDER.length : i;
  };
  const byTitle = (a, b) => (a.sortTitle || '').localeCompare(b.sortTitle || '');

  const SORTS = {
    added:   { label: 'Recently added', fn: (a, b) => (b.user.addedAt || 0) - (a.user.addedAt || 0) },
    release: { label: 'Release date',   fn: (a, b) => a.release.sortKey - b.release.sortKey },
    title:   { label: 'Title',          fn: byTitle },
    rating:  { label: 'Your rating',    fn: (a, b) => (b.user.rating || -1) - (a.user.rating || -1) },
    /* Sorting by type without also DRAWING the divisions just produces a list
       that looks arbitrarily ordered, so this sort is the one that groups. */
    type:    { label: 'Type', group: true,
               fn: (a, b) => (kindRank(a) - kindRank(b)) || byTitle(a, b) },
  };

  const mode = () => { try { return localStorage.getItem(MODE_KEY) || 'table'; } catch (_) { return 'table'; } };
  const setMode = m => { try { localStorage.setItem(MODE_KEY, m); } catch (_) {} };

  async function render(params, query) {
    const view = document.getElementById('view');
    const q = query || {};
    const all = await MT.repo.allItems();

    if (!all.length) return firstRun(view);

    let rows = all.slice();
    if (q.status) rows = rows.filter(i => i.user.status === q.status);
    if (q.kind === 'anime') rows = rows.filter(i => i.facets && i.facets.anime);
    else if (q.kind) rows = rows.filter(i => i.kind === q.kind);
    if (q.tag) rows = rows.filter(i => (i.user.tags || []).includes(q.tag));
    if (q.undated) rows = rows.filter(i => i.release.sortKey >= MT.util.SK_UNKNOWN);

    /* Out yet, or not. Two different questions get asked of a watchlist and
       the answer to both was buried in a mixed list:
         out   - what could I actually watch this evening
         soon  - what have I got to plan around, tickets and preorders

       Anything with no date at all is neither: an undated title is not
       watchable tonight, and it is not something you can plan around either.
       It has its own filter already. */
    if (q.avail === 'out') {
      /* A series counts as out once ANY of it has aired, not once the next
         episode lands — a show running weekly is watchable tonight. */
      rows = rows.filter(i => MT.ui.hasAired(i));
    } else if (q.avail === 'soon') {
      rows = rows.filter(i => !MT.ui.hasAired(i)
        && MT.ui.firstAiredKey(i) < MT.util.SK_UNKNOWN);
    }

    const sort = q.sort || 'added';
    rows.sort((SORTS[sort] || SORTS.added).fn);

    const label = q.tag ? `#${q.tag}`
      : q.avail === 'out' ? 'Out now'
      : q.avail === 'soon' ? 'Still to come'
      : q.status ? MT.ui.STATUS_WORD[q.status]
      : q.kind ? (MT.ui.KIND_LABEL[q.kind === 'movie' ? 'film' : q.kind] || q.kind)
      : 'All titles';
    MT.ui.crumb(['Library', label]);
    MT.ui.paneActions(`
      <div class="seg" id="modeSeg">
        <button type="button" data-mode="table" aria-pressed="${mode() === 'table'}">Table</button>
        <button type="button" data-mode="grid" aria-pressed="${mode() === 'grid'}">Posters</button>
      </div>`);

    const sel = MT.inspector.current;
    view.innerHTML = `
      <div class="toolbar">
        <div class="chips" id="kindChips">
          ${[['', 'All'], ['movie', 'Film'], ['tv', 'TV'], ['game', 'Games'], ['anime', 'Anime']].map(([k, l]) =>
            `<button class="chip" type="button" data-kind="${k}" aria-pressed="${(q.kind || '') === k}">${l}</button>`).join('')}
        </div>
        <div class="seg" id="availSeg">
          ${[['', 'Any'], ['out', 'Out now'], ['soon', 'Still to come']].map(([v, l]) =>
            `<button type="button" data-avail="${v}" aria-pressed="${(q.avail || '') === v}">${l}</button>`).join('')}
        </div>
        <div class="spacer"></div>
        <span class="count">${rows.length} of ${all.length}</span>
        <select id="sortSel" class="chip" aria-label="Sort by">
          ${Object.entries(SORTS).map(([k, v]) =>
            `<option value="${k}"${k === sort ? ' selected' : ''}>${v.label}</option>`).join('')}
        </select>
      </div>
      ${rows.length
        ? (mode() === 'grid'
            ? MT.ui.grid(rows, sel, groupOpts(sort))
            : MT.ui.table(rows, sel, groupOpts(sort)))
        : MT.ui.emptyState({
            title: 'Nothing here',
            body: 'No titles match these filters. Try a different status or type in the index on the left.',
          })}`;

    wire(view, q, sort);
  }

  /* Plural headings, because a section is a set: "Films", not "Film". */
  const GROUP_LABEL = { film: 'Films', tv: 'Television', game: 'Games', anime: 'Anime' };

  function groupOpts(sort) {
    if (!(SORTS[sort] || {}).group) return null;
    return { groupBy: it => GROUP_LABEL[MT.ui.kindOf(it)] || 'Other' };
  }

  function wire(view, q, sort) {
    const go = patch => {
      const next = Object.assign({}, q, patch);
      const parts = [];
      for (const [k, v] of Object.entries(next)) if (v) parts.push(`${k}=${encodeURIComponent(v)}`);
      MT.router.go('#/library' + (parts.length ? '?' + parts.join('&') : ''));
    };

    const chips = document.getElementById('kindChips');
    if (chips) chips.onclick = e => {
      const b = e.target.closest('[data-kind]');
      if (b) go({ kind: b.dataset.kind || '' });
    };

    const avail = document.getElementById('availSeg');
    if (avail) avail.onclick = e => {
      const b = e.target.closest('[data-avail]');
      if (b) go({ avail: b.dataset.avail || '' });
    };

    const sel = document.getElementById('sortSel');
    if (sel) sel.onchange = () => go({ sort: sel.value === 'added' ? '' : sel.value });

    const seg = document.getElementById('modeSeg');
    if (seg) seg.addEventListener('click', e => {
      const b = e.target.closest('[data-mode]');
      if (b) { setMode(b.dataset.mode); MT.router.resolve(); }
    });

    view.onclick = e => {
      /* Assignment, never addEventListener. #view outlives every route change,
         so a listener bound here stayed alive on OTHER routes: after one visit
         to the library, a tap on a search row ran this handler too and opened
         the inspector — including taps on the Add button, which raced its own
         await and rendered "Add to index" for a title just added. Assignment
         also cannot stack up, and this ran on every re-render. */
      if (e.target.closest('button, a, input, select, textarea, label')) return;
      const row = e.target.closest('[data-uid]');
      if (row) MT.inspector.show(row.dataset.uid);
    };
    void sort;
  }

  function firstRun(view) {
    const needsKey = !MT.config.hasKey('tmdb');
    MT.ui.crumb(['Library']);
    MT.ui.paneActions('');
    view.innerHTML = `
      <div class="firstrun">
        <h1>An index of everything<br>you mean to get to.</h1>
        <p class="lede">Films, television, games and anime in one list — with release dates that never
        pretend to know more than they do, ratings from several places kept in their own units, and
        recommendations built from your own taste.</p>

        ${needsKey ? `
          <div class="warnbox">
            <strong>One thing first</strong>
            MovieTrak needs a free TMDB API key to search. It takes about a minute and no card is required.
          </div>
          <ol>
            <li>Create an account at <a href="https://www.themoviedb.org/signup" target="_blank" rel="noopener">themoviedb.org</a>.</li>
            <li>Open <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener">Settings → API</a> and request a key.</li>
            <li>Paste the <b>API Key (v3 auth)</b> into MovieTrak’s settings.</li>
          </ol>
          <p style="margin-top:var(--mt-space-6)"><a class="btn btn--primary" href="#/settings">Paste my key →</a></p>
        ` : `
          <ol>
            <li>Press <kbd>/</kbd> to jump to the index filter, or open <a href="#/search">Search</a>.</li>
            <li>Type a title — films, television and games are searched at once.</li>
            <li>Press <kbd>⏎</kbd> to add the top result.</li>
          </ol>
          <p style="margin-top:var(--mt-space-6)" class="actions">
            <a class="btn btn--primary" href="#/search">Find something</a>
            <a class="btn" href="#/settings">Settings</a>
          </p>
        `}

        <div class="warnbox" style="margin-top:var(--mt-space-7)">
          <strong>Your library lives in the repository, not in this browser</strong>
          It is encrypted here before it is saved, so anyone can read the file and nobody can read your
          list. Sign in with the same passphrase on any device and you get the same single library.
          This browser keeps a working copy for speed, which is what makes it usable offline.
        </div>
      </div>`;
  }

  return { render };
})();
