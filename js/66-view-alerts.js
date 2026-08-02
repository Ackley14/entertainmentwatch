/* ══════════════════════════════════════════════════════════════════════════
   #/alerts — Activity. What changed since you last looked.
   ══════════════════════════════════════════════════════════════════════════ */

MT.viewAlerts = (function () {
  const esc = MT.util.escapeHtml;

  const LABEL = {
    'release.dated': 'Got a date', 'release.moved': 'Date moved', 'release.pulled': 'Date pulled',
    'release.precision': 'Date firmed up', 'release.today': 'Out today', 'release.soon': 'Out soon',
    'release.tickets_window': 'Booking window', 'status.changed': 'Status', 'status.cancelled': 'Cancelled',
    'season.new': 'New season', 'episode.next': 'Next episode', 'provider.added': 'Now streaming',
    'person.newProject': 'New project',
  };
  const ICON = {
    'release.moved': 'move', 'release.pulled': 'move', 'status.cancelled': 'move',
    'release.dated': 'land', 'release.today': 'land', 'release.precision': 'land',
    'season.new': 'land', 'provider.added': 'land', 'person.newProject': 'land',
  };

  async function render(params, query) {
    const view = document.getElementById('view');
    const showArchived = !!(query && query.archived);
    const rows = await MT.repo.feedItems({ includeArchived: showArchived });
    const unread = rows.filter(r => r.readAt == null).length;
    const lastSweep = await MT.repo.metaGet('sync.lastSweepAt');

    MT.ui.crumb(['Schedule', 'Activity']);
    MT.ui.paneActions(`
      <button class="btn btn--sm" id="sweepNow">${MT.sync.isSweeping() ? 'Checking…' : 'Check now'}</button>
      ${unread ? '<button class="btn btn--sm btn--ghost" id="readAll">Mark all read</button>' : ''}`);

    view.innerHTML = rows.length ? `
      <div class="two">
        <div class="col">
          <div class="hd">Changed recently${unread ? ` · ${unread} unread` : ''}</div>
          ${rows.map(evRow).join('')}
        </div>
        <div class="col">
          <div class="hd">How this works</div>
          <p class="muted" style="font-size:var(--mt-fs-sm);line-height:1.6">
            MovieTrak compares each title against a snapshot taken the last time it looked. There is no
            server watching on your behalf, so changes surface the next time you open the app.
          </p>
          <p class="muted" style="font-size:var(--mt-fs-sm);line-height:1.6;margin-top:var(--mt-space-4)">
            Last check: <b class="mono">${esc(MT.util.timeAgo(lastSweep))}</b>
          </p>
          <p style="margin-top:var(--mt-space-5)">
            <a class="btn btn--sm" href="#/alerts${showArchived ? '' : '?archived=1'}">
              ${showArchived ? 'Hide archived' : 'Show archived'}</a>
          </p>
        </div>
      </div>` : MT.ui.emptyState({
        title: 'No activity yet',
        body: 'When something in your index gets a release date, moves, or turns up on a streaming service, it appears here.',
        actions: '<button class="btn btn--primary" id="sweepEmpty">Check now</button>',
      });

    const doSweep = async () => {
      const btn = document.getElementById('sweepNow');
      if (btn) { btn.disabled = true; btn.textContent = 'Checking…'; }
      const rep = await MT.sync.sweep({ manual: true });
      MT.ui.toast(rep.skipped ? 'Already up to date'
        : `Checked ${rep.checked} · ${rep.alerts} update${rep.alerts === 1 ? '' : 's'}`);
      MT.router.resolve();
    };
    ['sweepNow', 'sweepEmpty'].forEach(id => {
      const b = document.getElementById(id); if (b) b.onclick = doSweep;
    });
    const ra = document.getElementById('readAll');
    if (ra) ra.onclick = async () => { await MT.repo.markAllFeedRead(); MT.router.resolve(); };

    view.onclick = e => {
      if (e.target.closest('button, a, input, select, textarea, label')) return;
      const r = e.target.closest('[data-uid]');
      if (r && r.dataset.uid) MT.inspector.show(r.dataset.uid);
    };

    if (unread) {
      setTimeout(async () => {
        if (!location.hash.startsWith('#/alerts')) return;
        await MT.repo.markFeedRead(rows.filter(r => r.readAt == null).map(r => r.feedId));
        MT.tree.refresh();
      }, 2500);
    }
  }

  function evRow(a) {
    const ic = ICON[a.type] || 'info';
    const glyph = ic === 'move' ? '↔' : ic === 'land' ? '▸' : 'i';
    return `<div class="ev ${a.readAt == null ? 'unread' : ''}" data-uid="${esc(a.uid || '')}">
      <div class="ic ${ic}">${glyph}</div>
      <div style="min-width:0">
        <div class="et">${esc(a.title)}</div>
        ${a.body ? `<div class="es">${esc(a.body)}</div>` : ''}
        <div class="es">${esc(LABEL[a.type] || a.type)}
          ${a.count > 1 ? ` · changed ${a.count}×` : ''}
          ${a.archivedFlag ? ' · archived' : ''}
          · ${esc(MT.util.timeAgo(a.lastAt))}</div>
        ${diff(a)}
      </div>
    </div>`;
  }

  /* A moved date is shown as both fields side by side, in the same grammar as
     everywhere else, so the change in PRECISION is visible too — not just the
     change in value. */
  function diff(a) {
    if (a.type !== 'release.moved' && a.type !== 'release.dated' && a.type !== 'release.pulled') return '';
    const mk = v => {
      const n = Number(v);
      if (!Number.isFinite(n)) return MT.ui.dateField(null);
      return MT.ui.dateField({ sortKey: n, precision: 'day', display: '' });
    };
    return `<div class="diff">${a.from ? mk(a.from) : MT.ui.dateField(null)}
      <span class="faint">→</span>${a.to ? mk(a.to) : MT.ui.dateField(null)}</div>`;
  }

  return { render };
})();
