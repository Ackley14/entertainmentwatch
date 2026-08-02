/* ══════════════════════════════════════════════════════════════════════════
   #/stats — the index in numbers, and the taste profile in the open.

   The profile section is deliberately the recommender's debug view. If the
   ranked terms do not obviously look like your taste, the profile is broken
   and no amount of ranking tuning will fix it — so it is worth being able to
   see it directly.
   ══════════════════════════════════════════════════════════════════════════ */

MT.viewStats = (function () {
  const esc = MT.util.escapeHtml;

  async function render() {
    const view = document.getElementById('view');
    const all = await MT.repo.allItems();
    MT.ui.crumb(['Schedule', 'Stats']);
    MT.ui.paneActions('');

    if (!all.length) {
      view.innerHTML = MT.ui.emptyState({ title: 'Nothing to count yet', body: 'Add a few titles and this fills in.' });
      return;
    }

    const byStatus = tally(all, i => i.user.status);
    const byKind = tally(all, i => MT.ui.kindOf(i));
    const rated = all.filter(i => i.user.rating != null);
    const avg = rated.length ? rated.reduce((s, i) => s + i.user.rating, 0) / rated.length : null;
    const backlogMin = all.filter(i => i.user.status === 'want' && i.runtimeMin)
      .reduce((s, i) => s + i.runtimeMin, 0);
    const undated = all.filter(i => i.release.sortKey >= MT.util.SK_UNKNOWN).length;
    const genres = rank(all.flatMap(i => (i.genres || []).map(g => g.name)));
    const people = rank(all.flatMap(i => (i.people || [])
      .filter(p => p.role === 'director' || p.role === 'creator').map(p => p.name)));
    const decades = rank(all.map(i => {
      const p = MT.util.sortKeyToParts(i.release.sortKey);
      return p ? `${Math.floor(p.y / 10) * 10}s` : null;
    }).filter(Boolean)).sort((a, b) => a[0].localeCompare(b[0]));

    const KIND_C = { film: 'var(--mt-type-film)', tv: 'var(--mt-type-tv)', game: 'var(--mt-type-game)', anime: 'var(--mt-type-anime)' };

    view.innerHTML = `
      <div class="two">
        <div class="col">
          <div class="tiles">
            ${tile(byStatus.want || 0, 'Want')}
            ${tile(byStatus.watching || 0, 'Watching')}
            ${tile(byStatus.watched || 0, 'Finished')}
            ${tile(rated.length, 'Rated')}
            ${tile(avg != null ? avg.toFixed(1) : '—', 'Your average')}
            ${tile(backlogMin ? Math.round(backlogMin / 60) : 0, 'Backlog hours')}
          </div>

          <div class="hd">Composition</div>
          <div class="stack">${Object.entries(byKind).map(([k, n]) =>
            `<i style="flex:${n};background:${KIND_C[k]}" title="${MT.ui.KIND_LABEL[k]}: ${n}"></i>`).join('')}</div>
          <div class="bars">${Object.entries(byKind).map(([k, n]) =>
            bar(MT.ui.KIND_LABEL[k], n, all.length, KIND_C[k])).join('')}</div>

          <div class="hd" style="margin-top:var(--mt-space-6)">Genres</div>
          <div class="bars">${genres.slice(0, 8).map(([l, n]) => bar(l, n, genres[0][1])).join('')}</div>

          ${people.length ? `<div class="hd" style="margin-top:var(--mt-space-6)">Directors &amp; creators</div>
            <div class="bars">${people.slice(0, 8).map(([l, n]) => bar(l, n, people[0][1])).join('')}</div>` : ''}

          ${decades.length ? `<div class="hd" style="margin-top:var(--mt-space-6)">By decade</div>
            <div class="bars">${decades.map(([l, n]) => bar(l, n, Math.max(...decades.map(d => d[1])))).join('')}</div>` : ''}
        </div>

        <div class="col">
          <div class="hd">Date certainty</div>
          <p class="muted" style="font-size:var(--mt-fs-sm);line-height:1.6;margin-bottom:var(--mt-space-4)">
            How much MovieTrak actually knows about when things arrive.
          </p>
          <div class="bars">${['day', 'month', 'quarter', 'year', 'tba', 'unknown']
            .map(p => [p, all.filter(i => i.release.precision === p).length])
            .filter(([, n]) => n)
            .map(([p, n]) => bar(precLabel(p), n, all.length)).join('')}</div>
          <p class="muted" style="font-size:var(--mt-fs-mini);margin-top:var(--mt-space-3)">
            ${undated} title${undated === 1 ? '' : 's'} with no date at all.
          </p>

          <div class="hd" style="margin-top:var(--mt-space-7)">Your taste profile</div>
          <p class="muted" style="font-size:var(--mt-fs-sm);line-height:1.6;margin-bottom:var(--mt-space-4)">
            The highest-weighted signals after inverse-document-frequency weighting. If these do not look
            like you, the recommendations will not either — rating a few more titles is the fastest fix.
          </p>
          <div id="profile">${MT.ui.skeletonGrid(1)}</div>

          <p class="faint" style="font-size:var(--mt-fs-micro);margin-top:var(--mt-space-6);line-height:1.5">
            Recommendations are computed on your device using cosine similarity over TF-IDF vectors.
            No AI model is involved.
          </p>
        </div>
      </div>`;

    loadProfile();
  }

  function precLabel(p) {
    return { day: 'Exact day', month: 'Month only', quarter: 'Quarter', year: 'Year only',
             tba: 'TBA', unknown: 'No date' }[p] || p;
  }

  async function loadProfile() {
    const host = document.getElementById('profile');
    if (!host) return;
    const out = [];
    for (const kind of ['movie', 'tv', 'game']) {
      const profile = await MT.rec.buildProfile(kind);
      if (profile.empty) continue;
      const labels = await labelTerms(MT.rec.topTerms(profile, 16), kind);
      if (!labels.length) continue;
      out.push(`<div style="margin-bottom:var(--mt-space-5)">
        <div class="blk-h">${kind === 'tv' ? 'Television' : kind === 'game' ? 'Games' : 'Films'}
          <span class="why">${profile.N} seeds</span></div>
        <div class="chips">${labels.map(l =>
          `<span class="chip" title="weight ${l.v.toFixed(3)}">${esc(l.label)}
            <span class="faint mono">${l.v.toFixed(2)}</span></span>`).join('')}</div>
      </div>`);
    }
    host.innerHTML = out.length ? out.join('')
      : MT.ui.emptyState({ title: 'No profile yet', body: 'Add and rate a few titles first.' });
  }

  /* Term ids are opaque; their labels live on the items that produced them. */
  async function labelTerms(top, kind) {
    const all = (await MT.repo.allItems()).filter(i => i.kind === kind);
    const lookup = new Map();
    for (const it of all) {
      for (const k of (it.keywords || [])) lookup.set(`kw:${k.source}:${k.id}`, k.name);
      for (const g of (it.genres || [])) lookup.set(`g:${g.source}:${g.id}`, g.name);
      for (const p of (it.people || [])) {
        const pre = p.role === 'cast' ? 'p:cast:'
          : (p.role === 'director' || p.role === 'creator') ? 'p:dir:'
          : p.role === 'writer' ? 'p:wri:' : 'p:oth:';
        lookup.set(pre + p.id, p.name);
      }
      for (const c of (it.companies || [])) lookup.set(`co:${c.source}:${String(c.id).replace(/^rawg:/, '')}`, c.name);
    }
    return top.map(t => ({ label: lookup.get(t.term) || pretty(t.term), v: t.v })).filter(x => x.label);
  }
  function pretty(term) {
    if (term.startsWith('tag:')) return term.split(':').pop().replace(/-/g, ' ');
    if (term.startsWith('play:')) return 'length ' + term.split(':')[1];
    if (term.startsWith('src:')) return term.split(':').pop().toLowerCase().replace('_', ' ');
    return null;
  }

  const tile = (v, l) => `<div class="tile"><div class="v">${esc(String(v))}</div><div class="l">${esc(l)}</div></div>`;
  const bar = (l, n, max, colour) => `<div class="bar">
    <span class="bl">${esc(l)}</span>
    <span class="g"><i style="width:${Math.round((n / (max || 1)) * 100)}%${colour ? `;background:${colour}` : ''}"></i></span>
    <span class="n">${n}</span></div>`;

  function tally(arr, fn) {
    const o = {};
    for (const x of arr) { const k = fn(x); if (k) o[k] = (o[k] || 0) + 1; }
    return o;
  }
  const rank = arr => Object.entries(tally(arr, x => x)).sort((a, b) => b[1] - a[1]);

  return { render };
})();
