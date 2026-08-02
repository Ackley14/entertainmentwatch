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

  /* The only place saving is ever mentioned. There is nothing to press. */
  async function refreshFooter(state) {
    try {
      const el = document.getElementById('footMeta');
      if (!el) return;
      const sweep = await MT.repo.metaGet('sync.lastSweepAt');
      const saved = await MT.repo.metaGet('cloud.lastPushAt');
      const bits = [];
      if (MT.crypto.isUnlocked()) {
        bits.push(state === 'saving' ? 'Saving…'
          : state === 'error' ? 'Could not save — see Settings'
          : saved ? `Saved ${MT.util.timeAgo(saved)}` : 'Not saved yet');
      }
      bits.push(`checked ${MT.util.timeAgo(sweep)}`);
      el.textContent = bits.join(' · ');
      el.className = 'mono' + (state === 'error' ? ' field__state--bad' : '');
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
     Saves should feel immediate, but every one is a git commit and GitHub's
     binding limit here is the secondary one — 80 content-generating requests
     a minute. So: fire quickly after a change, but never closer together than
     MIN_GAP. A burst of edits coalesces into one commit; a single edit lands
     in about a second. */
  const SAVE_DELAY = 900;
  const MIN_GAP = 4000;
  let lastPushAt = 0;

  function schedulePush() {
    if (!MT.crypto.isUnlocked() || !MT.cloud.hasWriteToken() || !MT.cloud.configured()) return;
    pendingPush = true;
    clearTimeout(pushTimer);
    const since = Date.now() - lastPushAt;
    const wait = Math.max(SAVE_DELAY, MIN_GAP - since);
    pushTimer = setTimeout(async () => {
      lastPushAt = Date.now();
      refreshFooter('saving');
      try { await MT.cloud.publish(); refreshFooter(); }
      catch (e) {
        {
          refreshFooter('error');
          /* A dead or expired token is the one thing that silently stops the
             whole model working, so it is never a passing toast. */
          const dead = /token|401|rejected|expired|Bad credentials/i.test(e.message || '');
          MT.ui.banner(dead
            ? 'Your GitHub token was rejected, so changes are no longer being saved. Sign in again to enter a new one.'
            : 'Could not save to GitHub: ' + (e.message || ''),
            dead ? { actionLabel: 'Fix it', onAction: () => MT.gate.open({ mode: 'token' }) } : {});
        }
      }
      finally { pendingPush = false; }
    }, wait);
  }

  function flushOnExit() {
    window.addEventListener('pagehide', () => {
      if (!pendingPush) return;
      clearTimeout(pushTimer);
      MT.cloud.publish().catch(() => {});
    });
  }

  /* ── Boot in two stages ────────────────────────────────────────────────
     The repository holds the library, so the gate runs first and the app only
     starts once we have a decrypted dataset (or the visitor has explicitly
     chosen to work offline). Splitting it this way means no view ever renders
     against a half-populated store. */
  async function start() {
    window.addEventListener('error', e => console.error('[uncaught]', e.error || e.message));
    window.addEventListener('unhandledrejection', e => {
      const r = e.reason;
      if (r && r.kind === 'abort') { e.preventDefault(); return; }
      console.error('[unhandled promise]', r);
    });

    MT.theme.init();
    await MT.db.open();
    await probeStorage();

    /* TMDB forbids retaining their data beyond six months; this purge is a
       compliance requirement, not housekeeping. */
    MT.repo.cachePurge().then(n => n && console.info(`[boot] purged ${n} expired cache rows`));

    /* A device that chose "stay signed in" holds the derived key, so it can go
       straight to the current library without asking again. */
    let resumed = false;
    if (MT.crypto.available() && MT.crypto.isRemembered()) {
      try {
        await MT.crypto.restoreFromDevice();
        const r = await MT.cloud.syncDown();
        resumed = r.exists;
      } catch (e) {
        console.warn('[boot] could not resume session', e);
        MT.crypto.lock();
      }
    }

    if (resumed) { await startApp(); return; }
    if (!MT.cloud.configured()) { await startApp(); return; }   // no repo: local only
    await MT.gate.open();
  }

  /* Everything from here needs a populated store. */
  let appStarted = false;
  async function startApp() {
    if (appStarted) return;
    appStarted = true;

    routes();
    MT.tree.init();
    MT.inspector.init();
    await MT.tree.refresh();

    MT.repo.subscribe((ev, detail) => {
      if (ev === 'item:put' || ev === 'item:delete' || ev === 'follow:change' ||
          ev === 'feed:change') schedulePush();
      /* A merge happened during a save: say so plainly and refresh what is on
         screen, because the library just changed underneath the user. */
      if (ev === 'sync:merged') {
        const s2 = detail || {};
        const bits = [];
        if (s2.added) bits.push(`${s2.added} added`);
        if (s2.updated) bits.push(`${s2.updated} updated`);
        if (s2.removed) bits.push(`${s2.removed} removed`);
        MT.ui.toast(
          bits.length
            ? `Changes from another device merged in — ${bits.join(', ')}.`
            : 'Changes from another device merged in.',
          { ms: 6000 });
        MT.tree.refresh();
        MT.router.resolve();
      }
    });

    MT.router.start();
    refreshFooter();
    noteOriginOnce();
    scheduleSweeps();
    flushOnExit();

    console.info('%cMovieTrak', 'color:#23E3C5;font-weight:600',
      `theme=${MT.theme.current()} storage=${MT.db.mode} signedIn=${MT.crypto.isUnlocked()} origin=${location.protocol}//${location.host || '(file)'}`);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();

  return { refreshFooter, schedulePush, start, startApp };
})();
