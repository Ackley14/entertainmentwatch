/* ══════════════════════════════════════════════════════════════════════════
   #/up — Coming Up.

   One shared timeline where PRECISION BECOMES WIDTH: a known day is a 3px
   pin, a month is a month wide, a year fills the year, and TBA has no
   position on the axis at all. Because every row is drawn against the same
   window, uncertainty is comparable at a glance — you can see that one title
   is pinned and another could land anywhere in a quarter.
   ══════════════════════════════════════════════════════════════════════════ */

MT.viewUp = (function () {
  const esc = MT.util.escapeHtml;

  async function render(params, query) {
    const view = document.getElementById('view');
    const q = query || {};
    const all = await MT.repo.allItems();
    const today = MT.util.todaySortKey();

    let rows = all.filter(i => i.user.status !== 'dropped' && i.user.status !== 'watched');
    if (q.kind === 'anime') rows = rows.filter(i => i.facets && i.facets.anime);
    else if (q.kind) rows = rows.filter(i => i.kind === q.kind);

    const undated = rows.filter(i => i.release.sortKey >= MT.util.SK_UNKNOWN);
    const dated = rows.filter(i => i.release.sortKey < MT.util.SK_UNKNOWN && i.release.sortKey >= today)
      .sort((a, b) => a.release.sortKey - b.release.sortKey);

    const showing = q.undated ? undated : dated;
    MT.ui.crumb(['Schedule', q.undated ? 'No date set' : 'Coming up']);
    MT.ui.paneActions(`
      <div class="seg">
        <button type="button" data-tab="dated" aria-pressed="${!q.undated}">Dated <span class="count">${dated.length}</span></button>
        <button type="button" data-tab="undated" aria-pressed="${!!q.undated}">No date <span class="count">${undated.length}</span></button>
      </div>`);

    /* The window is anchored on today and always spans at least two years, so
       bands stay comparable between visits. */
    const startY = MT.util.sortKeyToParts(today).y;
    const endY = Math.max(startY + 2, ...dated.map(i => MT.util.sortKeyToParts(i.release.sortKey).y));
    const span = { from: startY * 10000 + 101, to: endY * 10000 + 1231, startY, endY };

    view.innerHTML = `
      <div class="legend">
        <div><span class="band day" style="position:static;display:inline-block;width:3px"></span> <b>Exact day</b> — pinned</div>
        <div><span class="band month" style="position:static;display:inline-block;width:22px"></span> <b>Month only</b> — lands somewhere in the band</div>
        <div><span class="band year" style="position:static;display:inline-block;width:40px"></span> <b>Year only</b></div>
        <div><span class="band tba" style="position:static;display:inline-block;width:40px"></span> <b>TBA</b> — no position on the axis</div>
      </div>
      ${showing.length
        ? showing.map(it => row(it, span)).join('')
        : MT.ui.emptyState({
            title: q.undated ? 'Nothing undated' : 'Nothing on the horizon',
            body: q.undated
              ? 'Titles with no announced date at all will collect here.'
              : 'Add something unreleased and it will appear here — including titles that only have a year.',
          })}
      ${!q.undated && undated.length ? `
        ${MT.ui.groupHead('No date set', undated.length)}
        <p class="muted" style="padding:0 var(--mt-space-6) var(--mt-space-4);font-size:var(--mt-fs-sm);max-width:64ch">
          Announced, rumoured or simply undated. Nothing that has not been announced anywhere can be tracked by
          any source — <a href="#/people" style="text-decoration:underline">following the people and studios</a>
          behind them is how you hear first.
        </p>
        ${undated.map(it => row(it, span)).join('')}` : ''}`;

    view.addEventListener('click', e => {
      const r = e.target.closest('[data-uid]');
      if (r) MT.inspector.show(r.dataset.uid);
    });
    const pa = document.getElementById('paneActions');
    if (pa) pa.addEventListener('click', e => {
      const b = e.target.closest('[data-tab]');
      if (b) MT.router.go('#/up' + (b.dataset.tab === 'undated' ? '?undated=1' : ''));
    });
  }

  function row(it, span) {
    const rel = it.release;
    return `<div class="cu" data-uid="${esc(it.uid)}">
      ${MT.ui.poster(it, { size: MT.IMG.poster.sm })}
      <div>
        <div class="cu-t">${esc(it.title)}</div>
        <div class="cu-m">
          ${MT.ui.kindTag(it)}${MT.ui.precisionTag(rel)}
          <span class="mono faint" style="font-size:var(--mt-fs-mini)">${esc(MT.alerts.prettyType(rel.type))}</span>
          ${MT.ui.driftBadge(rel)}
        </div>
      </div>
      <div class="cu-r">
        <div class="cu-when">${MT.ui.whenText(rel)}</div>
        <div class="cu-when sub">${MT.ui.dateField(rel)}</div>
      </div>
      ${track(rel, span)}
    </div>`;
  }

  /* The band's geometry IS the claim. A day-precise date gets a pin; a month
     gets exactly that month's width; a year gets the year. Nothing is ever
     drawn narrower than the uncertainty it represents. */
  function track(rel, span) {
    const years = [];
    for (let y = span.startY; y <= span.endY; y++) years.push(y);
    const total = pos(span.to, span) || 1;

    let band = '';
    if (rel.sortKey >= MT.util.SK_UNKNOWN) {
      band = `<div class="band tba" title="No date announced"></div>`;
    } else {
      const p = MT.util.sortKeyToParts(rel.sortKey);
      if (rel.precision === 'day') {
        band = `<div class="band day" style="left:${pct(rel.sortKey, span)}%"></div>`;
      } else if (rel.precision === 'month') {
        const from = p.y * 10000 + p.m * 100 + 1;
        const to = p.y * 10000 + p.m * 100 + 28;
        band = `<div class="band month" style="left:${pct(from, span)}%;width:${Math.max(1.2, pct(to, span) - pct(from, span))}%"></div>`;
      } else if (rel.precision === 'quarter') {
        const q0 = (MT.util.quarterOf(p.m) - 1) * 3 + 1;
        const from = p.y * 10000 + q0 * 100 + 1;
        const to = p.y * 10000 + (q0 + 2) * 100 + 28;
        band = `<div class="band quarter" style="left:${pct(from, span)}%;width:${Math.max(2, pct(to, span) - pct(from, span))}%"></div>`;
      } else {
        const from = p.y * 10000 + 101, to = p.y * 10000 + 1231;
        band = `<div class="band year" style="left:${pct(from, span)}%;width:${Math.max(3, pct(to, span) - pct(from, span))}%"></div>`;
      }
    }
    void total;
    return `<div class="track">
      <div class="rail"></div>
      ${years.map(y => `<div class="gr" style="left:${pct(y * 10000 + 101, span)}%"></div>
        <div class="yr" style="left:${pct(y * 10000 + 630, span)}%">${y}</div>`).join('')}
      ${band}
    </div>`;
  }

  function pos(sk, span) { return MT.util.daysBetweenSortKeys(span.from, sk) || 0; }
  function pct(sk, span) {
    const total = MT.util.daysBetweenSortKeys(span.from, span.to) || 1;
    return MT.util.clamp((pos(sk, span) / total) * 100, 0, 100);
  }

  return { render };
})();
