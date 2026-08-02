/* ══════════════════════════════════════════════════════════════════════════
   #/list — the library.
   ══════════════════════════════════════════════════════════════════════════ */

MT.viewList = (function () {
  const esc = MT.util.escapeHtml;

  const SORTS = {
    added:    { label: 'Recently added',  fn: (a, b) => (b.user.addedAt || 0) - (a.user.addedAt || 0) },
    release:  { label: 'Release date',    fn: (a, b) => a.release.sortKey - b.release.sortKey },
    title:    { label: 'Title',           fn: (a, b) => (a.sortTitle || '').localeCompare(b.sortTitle || '') },
    rating:   { label: 'Rating',          fn: (a, b) => scoreOf(b) - scoreOf(a) },
    priority: { label: 'Priority',        fn: (a, b) => (b.user.priority || 0) - (a.user.priority || 0) },
  };

  function scoreOf(it) {
    const r = it.ratings || {};
    if (it.user && it.user.rating != null) return it.user.rating * 10;
    if (r.imdb) return r.imdb.score * 10;
    if (r.tmdb) return r.tmdb.score * 10;
    if (r.metacritic) return r.metacritic.score;
    if (r.rawg) return r.rawg.score * 20;
    return -1;
  }

  async function render(params, query) {
    const view = document.getElementById('view');
    const status = (query && query.status) || 'want';
    const kind = (query && query.kind) || 'all';
    const sort = (query && query.sort) || 'added';
    const tag = (query && query.tag) || '';

    const all = await MT.repo.allItems();
    if (!all.length) {
      view.innerHTML = MT.ui.emptyState({
        title: 'Your library is empty',
        body: 'Search for something at the top of the page and press <span class="num">Enter</span> to add it. Films, television and games all live here together.',
        actions: '<button class="btn btn--primary" onclick="document.getElementById(\'omni\').focus()">Search for something</button>',
      });
      return;
    }

    const counts = { want: 0, watching: 0, watched: 0, dropped: 0 };
    for (const it of all) counts[it.user.status] = (counts[it.user.status] || 0) + 1;

    let rows = all.filter(it => it.user.status === status);
    if (kind === 'anime') rows = rows.filter(it => it.facets && it.facets.anime);
    else if (kind !== 'all') rows = rows.filter(it => it.kind === kind);
    if (tag) rows = rows.filter(it => (it.user.tags || []).includes(tag));
    rows.sort(SORTS[sort] ? SORTS[sort].fn : SORTS.added.fn);

    const allTags = [...new Set(all.flatMap(it => it.user.tags || []))].sort();

    view.innerHTML = `
      <div class="pagehead">
        <div>
          <h1>Library</h1>
          <div class="pagehead__sub">${MT.util.pluralize(all.length, 'title')} tracked</div>
        </div>
      </div>

      <div class="toolbar">
        <div class="seg" role="group" aria-label="Status">
          ${['want', 'watching', 'watched', 'dropped'].map(s => `
            <button data-status="${s}" aria-pressed="${s === status}">
              ${MT.ui.statusWord(s)}<span class="count">${counts[s] || 0}</span>
            </button>`).join('')}
        </div>

        <div class="chiprow">
          ${[['all', 'Everything'], ['movie', 'Films'], ['tv', 'TV'], ['game', 'Games'], ['anime', 'Anime']]
            .map(([k, l]) => `<button class="chip" data-kind="${k}" aria-pressed="${k === kind}">${l}</button>`).join('')}
        </div>

        <div class="toolbar__spacer"></div>

        ${allTags.length ? `<select id="tag-filter" aria-label="Tag">
          <option value="">All tags</option>
          ${allTags.map(t => `<option value="${esc(t)}" ${t === tag ? 'selected' : ''}>${esc(t)}</option>`).join('')}
        </select>` : ''}

        <select id="sort" aria-label="Sort by">
          ${Object.entries(SORTS).map(([k, v]) =>
            `<option value="${k}" ${k === sort ? 'selected' : ''}>${v.label}</option>`).join('')}
        </select>
      </div>

      <div id="list-body">
        ${rows.length
          ? '<div class="grid">' + rows.map(it => MT.ui.posterCard(it, {
              hideStatus: true,
              extra: it.user.rating != null ? `<span class="num">★${it.user.rating}</span>` : '',
            })).join('') + '</div>'
          : MT.ui.emptyState({
              title: `Nothing in ${MT.ui.statusWord(status)}`,
              body: kind === 'all'
                ? 'Move something here from another tab, or add a new title.'
                : 'No matches with these filters.',
            })}
      </div>`;

    view.querySelector('.toolbar').addEventListener('click', e => {
      const s = e.target.closest('[data-status]');
      const k = e.target.closest('[data-kind]');
      if (s) go({ status: s.dataset.status, kind, sort, tag });
      if (k) go({ status, kind: k.dataset.kind, sort, tag });
    });
    const sortSel = document.getElementById('sort');
    if (sortSel) sortSel.onchange = () => go({ status, kind, sort: sortSel.value, tag });
    const tagSel = document.getElementById('tag-filter');
    if (tagSel) tagSel.onchange = () => go({ status, kind, sort, tag: tagSel.value });
  }

  function go(o) {
    const q = Object.entries(o).filter(([, v]) => v && v !== 'all' && v !== 'added')
      .map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
    MT.router.go('#/list' + (q ? '?' + q : ''));
  }

  return { render };
})();
