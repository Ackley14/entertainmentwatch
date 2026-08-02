/* ══════════════════════════════════════════════════════════════════════════
   Boot: route table, storage probe, background refresh, global error handling.
   ══════════════════════════════════════════════════════════════════════════ */

MT.boot = (function () {

  function routes() {
    MT.router.on('/',            () => MT.viewHome.render());
    MT.router.on('/search',      (p, q) => MT.viewSearch.render(p, q));
    MT.router.on('/list',        (p, q) => MT.viewList.render(p, q));
    MT.router.on('/up',          (p, q) => MT.viewUp.render(p, q));
    MT.router.on('/recs',        (p, q) => MT.viewRecs.render(p, q));
    MT.router.on('/alerts',      (p, q) => MT.viewAlerts.render(p, q));
    MT.router.on('/people',      () => MT.viewPeople.render());
    MT.router.on('/person/:id',  p => MT.viewPeople.renderPerson(p));
    MT.router.on('/stats',       () => MT.viewStats.render());
    MT.router.on('/settings',    () => MT.viewSettings.render());
    MT.router.on('/unlock',      (p, q) => MT.viewUnlock.render(p, q));
    MT.router.on('/item/:uid',   p => MT.viewItem.render(p));
  }

  /* ── Sync indicator ────────────────────────────────────────────────── */
  function refreshSyncChip() {
    const icon = document.getElementById('sync-icon');
    const chip = document.getElementById('sync-chip');
    if (!icon || !chip) return;
    if (!MT.cloud.configured()) { chip.hidden = true; return; }
    chip.hidden = false;
    if (!MT.crypto.isUnlocked()) {
      icon.textContent = '\u{1F512}';                    // locked
      chip.title = 'Locked — click to unlock your published library';
      chip.style.color = 'var(--bone-400)';
    } else if (pendingPush) {
      icon.textContent = '↻';                       // syncing
      chip.title = 'Publishing changes…';
      chip.style.color = 'var(--amber-200)';
    } else {
      icon.textContent = '●';                       // in sync
      chip.title = MT.cloud.hasToken()
        ? 'Unlocked and publishing to ' + MT.cloud.repo()
        : 'Unlocked — add a GitHub token in Settings to publish';
      chip.style.color = MT.cloud.hasToken() ? 'var(--good)' : 'var(--warn)';
    }
  }

  /* ── Auto-publish ──────────────────────────────────────────────────────
     Every save is a git commit, so writes are debounced hard rather than
     fired per keystroke. GitHub's binding limit here is the secondary one —
     80 content-generating requests a minute — which a naive per-edit push
     would hit while typing notes. */
  let pendingPush = false;
  let pushTimer = null;

  function schedulePush() {
    if (!MT.crypto.isUnlocked() || !MT.cloud.hasToken() || !MT.cloud.configured()) return;
    pendingPush = true;
    refreshSyncChip();
    clearTimeout(pushTimer);
    pushTimer = setTimeout(async () => {
      try {
        await MT.cloud.publish();
        pendingPush = false;
        refreshSyncChip();
        refreshFooter();
      } catch (e) {
        pendingPush = false;
        refreshSyncChip();
        console.warn('[sync] publish failed', e);
        MT.ui.toast('Could not publish to GitHub: ' + (e.message || ''), { bad: true });
      }
    }, 20000);
  }

  /* A pending commit must not be lost to a closed tab. This cannot await, so
     it is best-effort — the next launch republishes anyway. */
  function flushOnExit() {
    window.addEventListener('pagehide', () => {
      if (!pendingPush) return;
      clearTimeout(pushTimer);
      MT.cloud.publish().catch(() => {});
    });
  }

  async function refreshBadge() {
    try {
      const n = await MT.repo.unreadCount();
      const dot = document.getElementById('unread-dot');
      if (dot) dot.hidden = n === 0;
    } catch (_) {}
  }

  async function refreshFooter() {
    try {
      const backup = await MT.sync.backupCheck();
      const el = document.getElementById('backup-age');
      if (el && backup) {
        el.textContent = `Last export: ${backup.last ? MT.util.timeAgo(backup.last) : 'never'}`;
        el.className = backup.overdue ? 'stale' : '';
      }
      const sweep = await MT.repo.metaGet('sync.lastSweepAt');
      const s = document.getElementById('sweep-age');
      if (s) s.textContent = `Last checked: ${MT.util.timeAgo(sweep)}`;
    } catch (_) {}
  }

  /* Storage is genuinely fragile here. Ask for persistence, then verify the
     database actually round-trips — on file:// and in private windows it can
     open successfully and still lose everything. */
  async function probeStorage() {
    if (navigator.storage && navigator.storage.persist) {
      try { await navigator.storage.persist(); } catch (_) {}
    }
    try {
      await MT.repo.metaSet('boot.probe', Date.now());
      const back = await MT.repo.metaGet('boot.probe');
      if (!back) throw new Error('write did not round-trip');
    } catch (e) {
      MT.ui.banner('This browser is not letting MovieTrak store data reliably. Your library may vanish when you close the tab — export often.');
      console.error('[boot] storage probe failed', e);
    }
  }

  /* The file:// copy and any hosted copy are separate browser origins, so they
     hold entirely separate libraries. Saying so once prevents a confusing
     "where did my list go?" later. */
  async function noteOriginOnce() {
    if (location.protocol !== 'file:') return;
    const told = await MT.repo.metaGet('boot.toldAboutFileOrigin');
    if (told) return;
    const count = await MT.repo.countItems();
    if (count === 0) return;
    await MT.repo.metaSet('boot.toldAboutFileOrigin', true);
    MT.ui.banner('You are running the local copy. Browsers treat file:// as its own origin, so this library is separate from the one on your published site — move between them with Export and Import.');
  }

  async function backupNag() {
    const b = await MT.sync.backupCheck();
    if (!b || !b.overdue) return;
    MT.ui.banner(`It has been ${b.days} days since your last export. Local storage can be cleared without warning.`, {
      actionLabel: 'Export now',
      onAction: async () => { await MT.sync.exportToFile(); MT.ui.toast('Exported'); refreshFooter(); },
    });
  }

  /* Opportunistic background refresh: never on route change, only on a cold
     start and when the tab has been hidden a while. The sweep enforces its own
     four-hour cooldown and request budget on top of this. */
  function scheduleSweeps() {
    const kick = () => {
      if (!MT.config.hasKey('tmdb')) return;
      MT.sync.sweep({}).then(r => {
        if (r && r.alerts) {
          refreshBadge();
          MT.ui.toast(`${r.alerts} update${r.alerts === 1 ? '' : 's'} since last time`, {
            actionLabel: 'See', onAction: () => MT.router.go('#/alerts'),
          });
        }
        refreshFooter();
      }).catch(e => console.warn('[boot] sweep failed', e));
    };

    if ('requestIdleCallback' in window) requestIdleCallback(kick, { timeout: 6000 });
    else setTimeout(kick, 2500);

    let hiddenAt = 0;
    document.addEventListener('visibilitychange', () => {
      if (document.hidden) { hiddenAt = Date.now(); return; }
      if (hiddenAt && Date.now() - hiddenAt > MT.SWEEP.hiddenMsBeforeRecheck) kick();
    });
  }

  /* A fresh browser with a published library should say so rather than
     silently presenting an empty app — that is the whole "sign in on another
     machine" moment. */
  async function offerRestore() {
    if (!MT.crypto.available() || !MT.cloud.configured()) return;
    if (MT.crypto.isUnlocked()) return;
    if (location.hash.startsWith('#/unlock')) return;
    const local = await MT.repo.countItems();
    if (local > 0) return;                          // this device already has data
    const remote = await MT.cloud.peek();
    if (!remote.exists) return;
    MT.ui.banner(
      `A published library is available here${remote.counts ? ` (${remote.counts.items} titles)` : ''}. Enter your passphrase to load it.`,
      { actionLabel: 'Unlock', onAction: () => MT.router.go('#/unlock') });
  }

  async function start() {
    /* Anything below here that throws would leave a blank page, so the whole
       boot is wrapped and failures are shown rather than swallowed. */
    window.addEventListener('error', e => console.error('[uncaught]', e.error || e.message));
    window.addEventListener('unhandledrejection', e => {
      const r = e.reason;
      if (r && r.kind === 'abort') { e.preventDefault(); return; }
      console.error('[unhandled promise]', r);
    });

    routes();
    MT.viewSearch.init();
    MT.ui.installKeyboard();

    await MT.db.open();
    await probeStorage();

    /* TMDB forbids retaining their data beyond six months; this purge is a
       compliance requirement, not a housekeeping nicety. */
    MT.repo.cachePurge().then(n => n && console.info(`[boot] purged ${n} expired cache rows`));

    MT.repo.subscribe(event => {
      if (event === 'feed:change') refreshBadge();
      /* Background refresh writes go through putItemQuiet and deliberately do
         NOT emit item:put, so a sweep cannot trigger a commit per title. */
      if (event === 'item:put' || event === 'item:delete' || event === 'follow:change') schedulePush();
    });

    /* If a key was cached on this device, restore it before the first render
       so the app comes up already unlocked. */
    if (MT.crypto.available() && MT.crypto.isRemembered()) {
      try { await MT.crypto.restoreFromDevice(); } catch (_) {}
    }

    MT.router.start();
    refreshBadge();
    refreshFooter();
    refreshSyncChip();
    noteOriginOnce();
    backupNag();
    scheduleSweeps();
    flushOnExit();
    offerRestore();

    console.info('%cMovieTrak', 'color:#f5a623;font-weight:600',
      `storage=${MT.db.mode} origin=${location.protocol}//${location.host || '(file)'}`);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  return { refreshBadge, refreshFooter, refreshSyncChip, schedulePush, start };
})();
