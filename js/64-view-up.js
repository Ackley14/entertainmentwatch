/* ══════════════════════════════════════════════════════════════════════════
   #/up — Coming Up.

   The screen where date precision has to be honest. A title known only to
   "July 2027" is NOT placed on July 1st; it sits in a separate strip above the
   dated rows for that month. A title with no date at all gets its own bucket
   at the end rather than being hidden or faked.
   ══════════════════════════════════════════════════════════════════════════ */

MT.viewUp = (function () {
  const esc = MT.util.escapeHtml;

  async function render(params, query) {
    const view = document.getElementById('view');
    const kind = (query && query.kind) || 'all';
    const all = await MT.repo.allItems();

    let rows = all.filter(it => it.user.status !== 'dropped');
    if (kind === 'anime') rows = rows.filter(it => it.facets && it.facets.anime);
    else if (kind !== 'all') rows = rows.filter(it => it.kind === kind);

    const today = MT.util.todaySortKey();
    const dated = rows.filter(it => it.release.sortKey < MT.util.SK_UNKNOWN && it.release.sortKey >= today);
    const undated = rows.filter(it => it.release.sortKey >= MT.util.SK_UNKNOWN);
    const past = rows.filter(it => it.release.sortKey < today && it.user.status === 'want')
      .sort((a, b) => b.release.sortKey - a.release.sortKey).slice(0, 12);

    dated.sort((a, b) => a.release.sortKey - b.release.sortKey);

    /* Group by YEAR first, then by precision within the year.

       Doing it by month would be wrong: a year-precision item is anchored to
       January 1st purely so it sorts sensibly, and grouping on that anchor
       would file "sometime in 2027" under a January heading — inventing a
       month the source never gave us. Each precision gets its own bucket and
       its own honest label. */
    const years = new Map();
    for (const it of dated) {
      const p = MT.util.sortKeyToParts(it.release.sortKey);
      if (!years.has(p.y)) years.set(p.y, { year: [], quarters: new Map(), months: new Map() });
      const y = years.get(p.y);
      const prec = it.release.precision;
      if (prec === 'year') y.year.push(it);
      else if (prec === 'quarter') {
        const q = MT.util.quarterOf(p.m);
        if (!y.quarters.has(q)) y.quarters.set(q, []);
        y.quarters.get(q).push(it);
      } else {
        if (!y.months.has(p.m)) y.months.set(p.m, { precise: [], vague: [] });
        y.months.get(p.m)[prec === 'day' ? 'precise' : 'vague'].push(it);
      }
    }

    view.innerHTML = `
      <div class="pagehead">
        <div>
          <h1>Coming Up</h1>
          <div class="pagehead__sub">${MT.util.pluralize(dated.length, 'dated title')}
            ${undated.length ? ` · ${undated.length} without a date` : ''}</div>
        </div>
      </div>

      <div class="toolbar">
        <div class="chiprow">
          ${[['all', 'Everything'], ['movie', 'Films'], ['tv', 'TV'], ['game', 'Games'], ['anime', 'Anime']]
            .map(([k, l]) => `<button class="chip" data-kind="${k}" aria-pressed="${k === kind}">${l}</button>`).join('')}
        </div>
      </div>

      ${dated.length || undated.length ? '' : MT.ui.emptyState({
        title: 'Nothing on the horizon',
        body: 'Add something unreleased and it will show up here — including titles that only have a year, or no date at all.',
      })}

      <div class="timeline">
        ${[...years.entries()].sort((a, b) => a[0] - b[0]).map(([y, g]) => yearBlock(y, g)).join('')}
      </div>

      ${undated.length ? `
        <section class="section" style="margin-top:var(--s-7)">
          ${MT.ui.ruleHead('No date set', `${undated.length}`)}
          <p class="muted" style="font-size:var(--t-sm);margin-bottom:var(--s-4);max-width:60ch">
            Announced, rumoured, or simply undated. Nothing that has not been announced anywhere can be
            tracked by any source — following the people and studios behind them is how you hear first.
          </p>
          <div class="grid">${undated.map(it => MT.ui.posterCard(it, { hideStatus: true })).join('')}</div>
        </section>` : ''}

      ${past.length ? `
        <section class="section" style="margin-top:var(--s-7)">
          ${MT.ui.ruleHead('Already out, still on your list', `${past.length}`)}
          <div class="grid">${past.map(it => MT.ui.posterCard(it, { hideStatus: true })).join('')}</div>
        </section>` : ''}`;

    view.querySelector('.toolbar').addEventListener('click', e => {
      const k = e.target.closest('[data-kind]');
      if (k) MT.router.go('#/up' + (k.dataset.kind === 'all' ? '' : '?kind=' + k.dataset.kind));
    });
  }

  function yearBlock(y, g) {
    const total = g.year.length
      + [...g.quarters.values()].reduce((n, a) => n + a.length, 0)
      + [...g.months.values()].reduce((n, b) => n + b.precise.length + b.vague.length, 0);

    /* Vaguest first: a title known only to the year belongs above the months,
       because it could land in any of them. */
    let html = `
      <div class="timeline__month">
        <h2>${y}</h2>
        <span class="num">${total}</span>
      </div>
      ${g.year.length ? strip(`Sometime in ${y} — no month announced`, g.year) : ''}
      ${[...g.quarters.entries()].sort((a, b) => a[0] - b[0])
         .map(([q, list]) => strip(`Q${q} ${y} — no month announced`, list)).join('')}`;

    for (const [m, bucket] of [...g.months.entries()].sort((a, b) => a[0] - b[0])) {
      const name = MT.util.MONTHS[m - 1];
      html += `<div class="rulehead" style="margin-top:var(--s-4)">
                 <span class="rulehead__label">${esc(name)}</span>
                 <span class="rulehead__rule"></span>
                 <span class="rulehead__aside">${bucket.precise.length + bucket.vague.length}</span>
               </div>`;
      if (bucket.vague.length) html += strip(`Sometime in ${name} — no day announced`, bucket.vague);
      if (bucket.precise.length) html += `<div class="marquee">${bucket.precise.map(row).join('')}</div>`;
    }
    return html;
  }

  function strip(label, list) {
    return `<div class="vaguestrip">
      <div class="vaguestrip__label">${esc(label)}</div>
      <div class="marquee">${list.map(row).join('')}</div>
    </div>`;
  }

  function row(it) {
    const rel = it.release;
    const days = MT.util.daysUntil(rel.sortKey);
    /* A countdown against a month- or year-precise date would be inventing
       precision the source never gave us, so vaguer rows get the precision
       label instead of a number of days. */
    const when = rel.precision === 'day'
      ? `${MT.util.shortDate(rel.sortKey)}<small>${esc(MT.util.relativeDays(days))}</small>`
      : `${esc(rel.display)}<small>${esc(rel.precision)} only</small>`;
    return `<a class="marquee__row" href="#/item/${encodeURIComponent(it.uid)}">
      <div class="marquee__when">${when}</div>
      <div>
        <div class="marquee__title">${esc(it.title)}</div>
        <div class="marquee__meta">${esc(MT.alerts.prettyType(rel.type))} · ${esc(kindWord(it))}
          ${MT.ui.driftBadge(rel)}</div>
      </div>
      <div>${MT.ui.statusPill(rel)}</div>
    </a>`;
  }

  function kindWord(it) {
    if (it.facets && it.facets.anime) return 'Anime';
    return it.kind === 'tv' ? 'TV' : it.kind === 'game' ? 'Game' : 'Film';
  }

  return { render };
})();
