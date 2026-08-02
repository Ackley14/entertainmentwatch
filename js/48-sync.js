/* ══════════════════════════════════════════════════════════════════════════
   Refresh scheduling and the sweep runner.

   A static page has no background worker, so "keeping up to date" means: when
   the app is open, spend a bounded number of requests on whatever is most
   stale and most likely to have changed. The tier table decides how often an
   item is worth re-checking; the urgency queue decides what to spend today's
   budget on.
   ══════════════════════════════════════════════════════════════════════════ */

MT.sync = (function () {
  let sweeping = false;
  let abort = null;

  /* ── Tiering ───────────────────────────────────────────────────────────
     T3 (undated/speculative) sits at fourteen days, which looks wrong given
     that "it finally got a date" is the most valuable alert in the app. The
     resolution isn't to poll harder — it's to poll a different object. One
     combined_credits call on a followed director covers every undated project
     they're attached to, at a twelfth of the cost. See MT.alerts.checkFollow. */
  function tierOf(item) {
    const t = item.tracking || {};
    if (t.mutedFlag) return 'T5';

    /* For a series this is the NEXT episode, not the premiere. Judged on
       `release` alone, a show that began in 2016 and returns next week counts
       as nine years old and drops to the slowest tier — so the app would stop
       checking exactly when there was something to find. */
    const rel = (MT.ui && MT.ui.upcomingRelease ? MT.ui.upcomingRelease(item) : item.release) || {};
    const days = rel.sortKey < MT.util.SK_UNKNOWN ? MT.util.daysUntil(rel.sortKey) : null;
    const status = rel.status;
    const airing = item.kind === 'tv' && (status === 'ongoing' || (item.tvExtra && item.tvExtra.inProduction));

    if (item.user && item.user.status === 'watched' && days != null && days < 0) return 'T4';
    if (days != null && days >= -3 && days <= 14) return 'T0';
    if (airing && item.tvExtra && item.tvExtra.nextEpisode) return 'T0';
    if (days != null && days > 14 && days <= 90) return 'T1';
    if (airing) return 'T1';
    if (days != null && days > 90) return 'T2';
    if (status === 'in_production' || status === 'post_production') return 'T2';
    if (!days && (status === 'unannounced' || status === 'announced')) return 'T3';
    if (days != null && days < -540) return 'T4';
    return 'T2';
  }

  function retier(item) {
    const tier = tierOf(item);
    item.tracking = item.tracking || {};
    item.tracking.tier = tier;
    const ttl = MT.TIERS[tier].ttl;
    item.tracking.refreshDueAt = ttl === Infinity
      ? Number.MAX_SAFE_INTEGER
      : (item.tracking.lastRefreshAt || 0) + ttl;
    return item;
  }

  /* Urgency ages automatically: an item skipped this sweep has a larger
     staleness ratio next time, so it rises without any explicit fairness pass. */
  function urgency(item) {
    const t = item.tracking || {};
    const tier = MT.TIERS[t.tier || 'T2'];
    if (!tier || !tier.weight) return 0;
    const age = Date.now() - (t.lastRefreshAt || 0);
    const ratio = tier.ttl === Infinity ? 0 : age / tier.ttl;
    let affinity = 1;
    if (item.user && (item.user.rating >= 8 || item.user.priority > 0)) affinity = 1.3;
    return ratio * tier.weight * affinity;
  }

  /* ── The sweep ─────────────────────────────────────────────────────── */

  async function sweep(opts) {
    opts = opts || {};
    if (sweeping) return { skipped: 'already-running' };

    const last = (await MT.repo.metaGet('sync.lastSweepAt')) || 0;
    if (!opts.manual && Date.now() - last < MT.SWEEP.cooldownMs) {
      return { skipped: 'cooldown', nextAt: last + MT.SWEEP.cooldownMs };
    }

    sweeping = true;
    abort = new AbortController();
    const budget = Object.assign({}, opts.manual ? MT.SWEEP.manualBudget : MT.SWEEP.autoBudget);
    const report = { checked: 0, alerts: 0, errors: 0, skipped: 0, started: Date.now() };

    try {
      /* Local scan first — zero requests, and it catches "released today" even
         if every network call below fails. */
      const local = await MT.alerts.scanLocal();
      report.alerts += local.length;
      MT.repo.emit('sweep:progress', { phase: 'local', done: 0, total: 0 });

      const all = await MT.repo.allItems();
      for (const it of all) retier(it);

      const due = all
        .filter(it => (it.tracking.tier !== 'T5') &&
                      (it.tracking.refreshDueAt || 0) <= Date.now())
        .map(it => ({ it, u: urgency(it) }))
        .sort((a, b) => b.u - a.u);

      /* Alerts the user cares about should land in the first few seconds, so
         the queue is already urgency-ordered: T0 before T4, always. */
      const queue = due.filter(d => budgetFor(d.it, budget) > 0);
      const cap = Math.min(queue.length, budget.tmdb + budget.rawg);

      for (let i = 0; i < queue.length; i++) {
        if (abort.signal.aborted) break;
        const item = queue[i].it;
        const src = sourceFor(item);
        if (budget[src] <= 0) { report.skipped++; continue; }
        budget[src]--;

        try {
          const fresh = await refreshItem(item, { signal: abort.signal });
          if (fresh) {
            const emitted = await MT.alerts.checkItem(fresh);
            report.alerts += emitted.length;
          }
          report.checked++;
        } catch (e) {
          if (e && e.kind === 'abort') break;
          report.errors++;
          item.tracking.consecutiveFetchErrors = (item.tracking.consecutiveFetchErrors || 0) + 1;
          /* An upstream 404 is never allowed to delete user data. Three of
             them across at least a week only earns a "may have been removed"
             note, and even that is advisory. */
          if (e && e.kind === 'notfound') {
            if (!item.tracking.missSince) item.tracking.missSince = Date.now();
            item.tracking.lastRefreshAt = Date.now();
            await MT.repo.putItemQuiet(retier(item));
          }
        }
        MT.repo.emit('sweep:progress', { phase: 'remote', done: i + 1, total: cap });
      }

      /* Followed people and studios, round-robin so one big roster doesn't
         starve the rest. */
      const follows = (await MT.repo.allFollows())
        .sort((a, b) => (a.lastCheckedAt || 0) - (b.lastCheckedAt || 0))
        .slice(0, opts.manual ? 20 : 6);
      for (const f of follows) {
        if (abort.signal.aborted) break;
        if (budget.tmdb <= 0) break;
        budget.tmdb--;
        try {
          const emitted = await MT.alerts.checkFollow(f);
          report.alerts += emitted.length;
        } catch (_) { report.errors++; }
      }

      await MT.repo.metaSet('sync.lastSweepAt', Date.now());
      report.finished = Date.now();
      MT.repo.emit('sweep:done', report);
      return report;
    } finally {
      sweeping = false;
      abort = null;
    }
  }

  function sourceFor(item) { return item.kind === 'game' ? 'rawg' : 'tmdb'; }
  function budgetFor(item, budget) { return budget[sourceFor(item)]; }

  /* Refresh a single item from its primary source and merge. */
  async function refreshItem(item, opts) {
    opts = opts || {};
    let fresh = null;

    if (item.kind === 'game') {
      if (!MT.config.hasKey('rawg') || !item.ids.rawg) return null;
      const raw = await MT.rawg.game(item.ids.rawg, { fresh: true, signal: opts.signal });
      fresh = MT.normalize.fromRawg(raw);
    } else {
      if (!MT.config.hasKey('tmdb') || !item.ids.tmdb) return null;
      const raw = await MT.tmdb.details(item.kind, item.ids.tmdb, { fresh: true, signal: opts.signal });
      fresh = MT.normalize.fromTmdb(raw, item.kind);
    }

    const merged = MT.normalize.mergeItem(item, fresh);

    /* Record drift so the item page can say "moved Mar 19 → Jul 16". */
    if (item.release && merged.release && item.release.sortKey !== merged.release.sortKey) {
      merged.release.history = (item.release.history || []).concat([{
        observedAt: Date.now(),
        from: { raw: item.release.raw, precision: item.release.precision, sortKey: item.release.sortKey },
        to: { raw: merged.release.raw, precision: merged.release.precision, sortKey: merged.release.sortKey },
        deltaDays: MT.util.daysBetweenSortKeys(item.release.sortKey, merged.release.sortKey),
      }]).slice(-MT.LIMITS.driftHistory);
    }

    merged.tracking.lastRefreshAt = Date.now();
    retier(merged);
    MT.repo.dfObserve(merged.uid, Object.keys(merged.rec.terms || {}));
    await MT.repo.putItemQuiet(merged);
    return merged;
  }

  function cancel() { if (abort) abort.abort(); }
  const isSweeping = () => sweeping;

  return {
    tierOf, retier, urgency, sweep, refreshItem, cancel, isSweeping,
  };
})();
