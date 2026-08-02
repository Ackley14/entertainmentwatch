/* ══════════════════════════════════════════════════════════════════════════
   #/alerts — the activity feed.

   Everything here was produced by diffing a fresh fetch against the snapshot
   from last time. Detection latency is therefore bounded by how often the app
   is opened, and the footer says so rather than letting it read as a bug.
   ══════════════════════════════════════════════════════════════════════════ */

MT.viewAlerts = (function () {
  const esc = MT.util.escapeHtml;

  const TYPE_LABEL = {
    'release.dated': 'Got a date', 'release.moved': 'Date moved',
    'release.pulled': 'Date pulled', 'release.precision': 'Date firmed up',
    'release.today': 'Out today', 'release.soon': 'Out soon',
    'release.tickets_window': 'Booking window', 'status.changed': 'Status',
    'status.cancelled': 'Cancelled', 'season.new': 'New season',
    'episode.next': 'Next episode', 'provider.added': 'Now streaming',
    'person.newProject': 'New project',
  };

  async function render(params, query) {
    const view = document.getElementById('view');
    const filter = (query && query.type) || '';
    const showArchived = !!(query && query.archived);

    const rows = await MT.repo.feedItems({ includeArchived: showArchived, type: filter || undefined });
    const unread = rows.filter(r => r.readAt == null).length;
    const lastSweep = await MT.repo.metaGet('sync.lastSweepAt');

    const types = [...new Set((await MT.repo.feedItems({ includeArchived: true })).map(r => r.type))];

    view.innerHTML = `
      <div class="pagehead">
        <div>
          <h1>Activity</h1>
          <div class="pagehead__sub">
            ${rows.length ? `${MT.util.pluralize(rows.length, 'update')}${unread ? ` · ${unread} unread` : ''}` : 'Nothing yet'}
          </div>
        </div>
        <div class="pagehead__act">
          <button class="btn" id="sweep-now">${MT.sync.isSweeping() ? 'Checking…' : 'Check for updates'}</button>
          ${unread ? '<button class="btn btn--ghost" id="mark-all">Mark all read</button>' : ''}
        </div>
      </div>

      ${types.length > 1 ? `<div class="toolbar">
        <div class="chiprow">
          <button class="chip" data-type="" aria-pressed="${!filter}">All</button>
          ${types.map(t => `<button class="chip" data-type="${esc(t)}" aria-pressed="${filter === t}">${esc(TYPE_LABEL[t] || t)}</button>`).join('')}
        </div>
        <div class="toolbar__spacer"></div>
        <button class="chip" data-archived aria-pressed="${showArchived}">Show archived</button>
      </div>` : ''}

      ${rows.length ? `<div class="feed">${groupByDay(rows)}</div>` : MT.ui.emptyState({
        title: 'No activity yet',
        body: 'When something in your library gets a release date, moves, or turns up on a streaming service, it appears here.',
        actions: '<button class="btn btn--primary" id="sweep-empty">Check now</button>',
      })}

      <p class="dim" style="font-size:var(--t-xs);margin-top:var(--s-6);max-width:70ch">
        MovieTrak checks for changes while it is open — there is no server watching on your behalf, so
        updates appear the next time you visit. Last check: ${esc(MT.util.timeAgo(lastSweep))}.
      </p>`;

    const doSweep = async () => {
      const btn = document.getElementById('sweep-now');
      if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
      const report = await MT.sync.sweep({ manual: true });
      if (report.skipped) MT.ui.toast('Already up to date');
      else MT.ui.toast(`Checked ${report.checked} titles — ${report.alerts} update${report.alerts === 1 ? '' : 's'}`);
      MT.router.resolve();
    };
    const b1 = document.getElementById('sweep-now'); if (b1) b1.onclick = doSweep;
    const b2 = document.getElementById('sweep-empty'); if (b2) b2.onclick = doSweep;
    const b3 = document.getElementById('mark-all');
    if (b3) b3.onclick = async () => { await MT.repo.markAllFeedRead(); MT.router.resolve(); };

    const tb = view.querySelector('.toolbar');
    if (tb) tb.addEventListener('click', e => {
      const t = e.target.closest('[data-type]');
      const a = e.target.closest('[data-archived]');
      if (t) MT.router.go('#/alerts' + (t.dataset.type ? '?type=' + encodeURIComponent(t.dataset.type) : ''));
      if (a) MT.router.go('#/alerts' + (showArchived ? '' : '?archived=1'));
    });

    /* Read-on-view, but only after a beat — flicking past a screen should not
       silently clear the badge. */
    if (unread) {
      setTimeout(async () => {
        if (!location.hash.startsWith('#/alerts')) return;
        await MT.repo.markFeedRead(rows.filter(r => r.readAt == null).map(r => r.feedId));
        MT.boot.refreshBadge();
      }, 2500);
    }
  }

  function groupByDay(rows) {
    const groups = new Map();
    for (const r of rows) {
      const key = MT.util.dayLabel(r.lastAt);
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(r);
    }
    let html = '';
    for (const [day, list] of groups) {
      html += `<div class="feed__day">${esc(day)}</div>`;
      html += list.map(alertRow).join('');
    }
    return html;
  }

  function alertRow(a) {
    const href = a.uid ? `#/item/${encodeURIComponent(a.uid)}` : '#/alerts';
    const poster = a.posterPath
      ? (/^https?:/.test(a.posterPath) ? a.posterPath : MT.tmdb.img(a.posterPath, MT.IMG.poster.sm))
      : null;
    return `<a class="alert ${a.readAt == null ? 'alert--unread' : ''} ${a.severity === 'high' ? 'alert--sev-high' : ''}"
               href="${esc(href)}">
      ${poster ? `<img class="alert__art" loading="lazy" src="${esc(poster)}" alt="">`
               : '<span class="alert__art"></span>'}
      <div class="alert__body">
        <span class="alert__title">${esc(a.title)}</span>
        ${a.body ? `<div class="muted" style="font-size:var(--t-xs)">${esc(a.body)}</div>` : ''}
        <div class="dim" style="font-size:var(--t-xs)">${esc(TYPE_LABEL[a.type] || a.type)}
          ${a.count > 1 ? `<span class="alert__count">· changed ${a.count}×</span>` : ''}
          ${a.archivedFlag ? '<span class="alert__count">· archived</span>' : ''}</div>
      </div>
      <span class="alert__when">${esc(MT.util.timeAgo(a.lastAt))}</span>
    </a>`;
  }

  return { render };
})();
