/* ══════════════════════════════════════════════════════════════════════════
   Boot: routes, storage probe, background refresh, global error handling.
   ══════════════════════════════════════════════════════════════════════════ */

MT.boot = (function () {
  let pendingPush = false;
  let pushTimer = null;

  function routes() {
    /* Library is the front door. There is no separate "home" — the index tree
       is always visible, so a dashboard would just be a second navigation. */
    MT.router.on('/',           (p, q) => MT.viewLibrary.render(p, q));
    MT.router.on('/library',    (p, q) => MT.viewLibrary.render(p, q));
    MT.router.on('/up',         (p, q) => MT.viewUp.render(p, q));
    MT.router.on('/search',     (p, q) => MT.viewSearch.render(p, q));
    MT.router.on('/recs',       (p, q) => MT.viewRecs.render(p, q));
    MT.router.on('/alerts',     (p, q) => MT.viewAlerts.render(p, q));
    MT.router.on('/people',     () => MT.viewPeople.render());
    MT.router.on('/stats',      () => MT.viewStats.render());
    MT.router.on('/settings',   () => { MT.ui.crumb(['System', 'Settings']); MT.ui.paneActions(''); return MT.viewSettings.render(); });
    MT.router.on('/unlock',     (p, q) => { MT.ui.crumb(['System', 'Sync']); MT.ui.paneActions(''); return MT.viewUnlock.render(p, q); });
    /* Item is not a page any more — it selects into the inspector and leaves
       the list underneath intact. The route survives so links still work. */
    MT.router.on('/item/:uid',  async p => {
      await MT.viewLibrary.render({}, {});
      MT.inspector.show(p.uid);
    });
  }

  async function refreshFooter() {
    try {
      const backup = await MT.sync.backupCheck();
      const sweep = await MT.repo.metaGet('sync.lastSweepAt');
      const el = document.getElementById('footMeta');
      if (!el) return;
      const bits = [`Last checked ${MT.util.timeAgo(sweep)}`];
      if (backup) bits.push(`last export ${backup.last ? MT.util.timeAgo(backup.last) : 'never'}${backup.overdue ? ' — overdue' : ''}`);
      if (MT.cloud.configured() && MT.crypto.isUnlocked()) bits.push('sync unlocked');
      el.textContent = bits.join(' · ');
    } catch (_) {}
  }

  async function probeStorage() {
    if (navigator.storage && navigator.storage.persist) {
      try { await navigator.storage.persist(); } catch (_) {}
    }
    try {
      await MT.repo.metaSet('boot.probe', Date.now());
      if (!(await MT.repo.metaGet('boot.probe'))) throw new Error('write did not round-trip');
    } catch (e) {
      MT.ui.banner('This browser is not letting MovieTrak store data reliably. Your index may vanish when you close the tab — export often.');
      console.error('[boot] storage probe failed', e);
    }
  }

  /* file:// and any hosted copy are separate browser origins, so they hold
     separate indexes. Saying so once prevents a confusing "where did my list
     go?" later. */
  async function noteOriginOnce() {
    if (location.protocol !== 'file:') return;
    if (await MT.repo.metaGet('boot.toldAboutFileOrigin')) return;
    if ((await MT.repo.countItems()) === 0) return;
    await MT.repo.metaSet('boot.toldAboutFileOrigin', true);
    MT.ui.banner('You are running the local copy. Browsers treat file:// as its own origin, so this index is separate from the one on your published site — move between them with the passphrase sync, or Export and Import.');
  }

  async function backupNag() {
    const b = await MT.sync.backupCheck();
    if (!b || !b.overdue) return;
    if (MT.cloud.configured() && MT.crypto.isUnlocked() && MT.cloud.hasToken()) return;  // sync covers it
    MT.ui.banner(`It has been ${b.days} days since your last export. Local storage can be cleared without warning.`, {
      actionLabel: 'Export now',
      onAction: async () => { await MT.sync.exportToFile(); MT.ui.toast('Exported'); refreshFooter(); },
    });
  }

  /* Opportunistic background refresh: never on route change, only on a cold
     start and after the tab has been hidden a while. The sweep enforces its
     own cooldown and request budget on top of this. */
  function scheduleSweeps() {
    const kick = () => {
      if (!MT.config.hasKey('tmdb')) return;
      MT.sync.sweep({}).then(r => {
        if (r && r.alerts) {
          MT.tree.refresh();
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

  /* ── Encrypted publish ────────────────────────────────────────────────
     Every save is a git commit, so writes are debounced hard. GitHub's binding
     limit here is the secondary one — 80 content-generating requests a minute
     — which a per-keystroke push would hit while typing notes. */
  function schedulePush() {
    if (!MT.crypto.isUnlocked() || !MT.cloud.hasToken() || !MT.cloud.configured()) return;
    pendingPush = true;
    clearTimeout(pushTimer);
    pushTimer = setTimeout(async () => {
      try { await MT.cloud.publish(); refreshFooter(); }
      catch (e) { MT.ui.toast('Could not publish to GitHub: ' + (e.message || ''), { bad: true }); }
      finally { pendingPush = false; }
    }, 20000);
  }

  function flushOnExit() {
    window.addEventListener('pagehide', () => {
      if (!pendingPush) return;
      clearTimeout(pushTimer);
      MT.cloud.publish().catch(() => {});
    });
  }

  async function offerRestore() {
    if (!MT.crypto.available() || !MT.cloud.configured()) return;
    if (MT.crypto.isUnlocked() || location.hash.startsWith('#/unlock')) return;
    if ((await MT.repo.countItems()) > 0) return;
    const remote = await MT.cloud.peek();
    if (!remote.exists) return;
    MT.ui.banner(
      `A published library is available here${remote.counts ? ` (${remote.counts.items} titles)` : ''}. Enter your passphrase to load it.`,
      { actionLabel: 'Unlock', onAction: () => MT.router.go('#/unlock') });
  }

  async function start() {
    window.addEventListener('error', e => console.error('[uncaught]', e.error || e.message));
    window.addEventListener('unhandledrejection', e => {
      const r = e.reason;
      if (r && r.kind === 'abort') { e.preventDefault(); return; }
      console.error('[unhandled promise]', r);
    });

    MT.theme.init();
    routes();

    await MT.db.open();
    await probeStorage();

    /* TMDB forbids retaining their data beyond six months; this purge is a
       compliance requirement, not housekeeping. */
    MT.repo.cachePurge().then(n => n && console.info(`[boot] purged ${n} expired cache rows`));

    if (MT.crypto.available() && MT.crypto.isRemembered()) {
      try { await MT.crypto.restoreFromDevice(); } catch (_) {}
    }

    MT.tree.init();
    MT.inspector.init();
    await MT.tree.refresh();

    MT.repo.subscribe(ev => {
      if (ev === 'item:put' || ev === 'item:delete' || ev === 'follow:change') schedulePush();
    });

    MT.router.start();
    refreshFooter();
    noteOriginOnce();
    backupNag();
    scheduleSweeps();
    flushOnExit();
    offerRestore();

    console.info('%cMovieTrak', 'color:#23E3C5;font-weight:600',
      `theme=${MT.theme.current()} storage=${MT.db.mode} origin=${location.protocol}//${location.host || '(file)'}`);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  return { refreshFooter, schedulePush, start };
})();
