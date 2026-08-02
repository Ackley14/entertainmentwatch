/* ══════════════════════════════════════════════════════════════════════════
   #/stats — the library in numbers, and the taste profile in the open.

   The second half of this screen is deliberately the recommender's debug view.
   If the ranked keyword and people lists do not look obviously like your
   taste, the profile is broken — and no amount of tuning the ranking will fix
   that. Being able to see it is worth more than any chart here.
   ══════════════════════════════════════════════════════════════════════════ */

MT.viewStats = (function () {
  const esc = MT.util.escapeHtml;

  async function render() {
    const view = document.getElementById('view');
    const all = await MT.repo.allItems();

    if (!all.length) {
      view.innerHTML = MT.ui.emptyState({ title: 'Nothing to count yet',
        body: 'Add a few titles and this page fills in.' });
      return;
    }

    const byStatus = tally(all, it => it.user.status);
    const byKind = tally(all, it => (it.facets && it.facets.anime) ? 'anime' : it.kind);
    const genres = rank(all.flatMap(it => (it.genres || []).map(g => g.name)));
    const people = rank(all.flatMap(it => (it.people || [])
      .filter(p => p.role === 'director' || p.role === 'creator').map(p => p.name)));
    const decades = rank(all.map(it => {
      const p = MT.util.sortKeyToParts(it.release.sortKey);
      return p ? `${Math.floor(p.y / 10) * 10}s` : null;
    }).filter(Boolean)).sort((a, b) => a[0].localeCompare(b[0]));

    const rated = all.filter(it => it.user.rating != null);
    const avg = rated.length ? rated.reduce((s, it) => s + it.user.rating, 0) / rated.length : null;
    const runtime = all.filter(it => it.user.status === 'want' && it.runtimeMin)
      .reduce((s, it) => s + it.runtimeMin, 0);

    view.innerHTML = `
      <div class="pagehead"><div><h1>Stats</h1>
        <div class="pagehead__sub">${MT.util.pluralize(all.length, 'title')} tracked</div></div></div>

      <section class="section">
        <div class="statgrid">
          ${stat(byStatus.want || 0, 'Want to watch')}
          ${stat(byStatus.watched || 0, 'Finished')}
          ${stat(rated.length, 'Rated')}
          ${stat(avg != null ? avg.toFixed(1) : '—', 'Your average', avg != null ? '/10' : '')}
          ${stat(runtime ? Math.round(runtime / 60) : 0, 'Hours in the backlog', 'h')}
        </div>
      </section>

      <section class="section">
        ${MT.ui.ruleHead('Composition')}
        <div class="bars">
          ${bars(Object.entries(byKind).map(([k, v]) => [kindWord(k), v]), all.length)}
        </div>
      </section>

      <section class="section">
        ${MT.ui.ruleHead('Genres')}
        <div class="bars">${bars(genres.slice(0, 10), genres[0] ? genres[0][1] : 1)}</div>
      </section>

      ${people.length ? `<section class="section">
        ${MT.ui.ruleHead('Directors & creators')}
        <div class="bars">${bars(people.slice(0, 10), people[0][1])}</div>
      </section>` : ''}

      ${decades.length ? `<section class="section">
        ${MT.ui.ruleHead('By decade')}
        <div class="bars">${bars(decades, Math.max(...decades.map(d => d[1])))}</div>
      </section>` : ''}

      <section class="section">
        ${MT.ui.ruleHead('Your taste profile', 'what drives recommendations')}
        <p class="muted" style="font-size:var(--t-sm);max-width:66ch;margin-bottom:var(--s-4)">
          These are the highest-weighted signals in your profile after inverse-document-frequency weighting.
          If they do not look like you, the recommendations will not either — rating a few more titles is
          the fastest fix.
        </p>
        <div id="profile-body">${MT.ui.skeletonGrid(1)}</div>
      </section>

      <p class="dim" style="font-size:var(--t-xs);margin-top:var(--s-6);max-width:70ch">
        Recommendations are computed on your device using cosine similarity over TF-IDF vectors.
        No AI model is involved.
      </p>`;

    loadProfile();
  }

  async function loadProfile() {
    const host = document.getElementById('profile-body');
    if (!host) return;
    const out = [];
    for (const kind of ['movie', 'tv', 'game']) {
      const profile = await MT.rec.buildProfile(kind);
      if (profile.empty) continue;
      const top = MT.rec.topTerms(profile, 18);
      const labels = await labelTerms(top, kind);
      out.push(`
        <div class="deck" style="margin-bottom:var(--s-4)">
          <div class="deck__label">${kindWord(kind)} <span class="dim">${profile.N} seeds</span></div>
          <div class="chiprow">
            ${labels.map(l => `<span class="chip" title="weight ${l.v.toFixed(3)}">${esc(l.label)}
              <span class="dim num">${l.v.toFixed(2)}</span></span>`).join('')}
          </div>
        </div>`);
    }
    host.innerHTML = out.length ? out.join('') : MT.ui.emptyState({
      title: 'No profile yet', body: 'Add and rate a few titles first.' });
  }

  /* Term ids are opaque; the labels live on the items that produced them. */
  async function labelTerms(top, kind) {
    const all = (await MT.repo.allItems()).filter(i => i.kind === kind);
    const lookup = new Map();
    for (const it of all) {
      for (const k of (it.keywords || [])) lookup.set(`kw:${k.source}:${k.id}`, k.name);
      for (const g of (it.genres || [])) lookup.set(`g:${g.source}:${g.id}`, g.name);
      for (const p of (it.people || [])) {
        const pre = p.role === 'cast' ? 'p:cast:' : (p.role === 'director' || p.role === 'creator') ? 'p:dir:'
                  : p.role === 'writer' ? 'p:wri:' : 'p:oth:';
        lookup.set(pre + p.id, p.name);
      }
      for (const c of (it.companies || [])) lookup.set(`co:${c.source}:${String(c.id).replace(/^rawg:/, '')}`, c.name);
    }
    return top.map(t => ({
      label: lookup.get(t.term) || prettyTerm(t.term),
      v: t.v,
    })).filter(x => x.label);
  }

  function prettyTerm(term) {
    if (term.startsWith('tag:')) return term.split(':').pop().replace(/-/g, ' ');
    if (term.startsWith('play:')) return 'length ' + term.split(':')[1];
    if (term.startsWith('src:')) return term.split(':').pop().toLowerCase().replace('_', ' ');
    return null;
  }

  function stat(n, label, suffix) {
    return `<div class="stat">
      <div class="stat__n">${esc(String(n))}${suffix ? `<small>${esc(suffix)}</small>` : ''}</div>
      <div class="stat__l">${esc(label)}</div></div>`;
  }

  function bars(pairs, max) {
    return pairs.map(([label, n]) => `
      <div class="bar">
        <span class="bar__l">${esc(label)}</span>
        <span class="bar__t"><span class="bar__f" style="width:${Math.round((n / (max || 1)) * 100)}%"></span></span>
        <span class="bar__n">${n}</span>
      </div>`).join('');
  }

  function tally(arr, fn) {
    const o = {};
    for (const x of arr) { const k = fn(x); if (k) o[k] = (o[k] || 0) + 1; }
    return o;
  }
  function rank(arr) {
    const o = tally(arr, x => x);
    return Object.entries(o).sort((a, b) => b[1] - a[1]);
  }
  function kindWord(k) {
    return ({ movie: 'Films', tv: 'Television', game: 'Games', anime: 'Anime' })[k] || k;
  }

  return { render };
})();
