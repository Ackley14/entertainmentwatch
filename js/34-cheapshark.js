/* ══════════════════════════════════════════════════════════════════════════
   CheapShark — what a game actually costs.

   Nothing else browser-reachable can answer this. Steam's own storefront API,
   its Web API and SteamSpy are all CORS-blocked; IsThereAnyDeal is too. Of
   fourteen candidates probed from both a served origin and file://, CheapShark
   was one of two that answered at all — no key, no registration, `ACAO: *`.

   It aggregates roughly thirty PC stores, so the number shown is the cheapest
   price anywhere rather than Steam's, which is more useful and also more
   honest than quoting one shop.

   Two limits, both stated in the UI rather than hidden:

   · PC only. There is no browser-reachable source of console pricing at all,
     so a console-exclusive simply has no price here.
   · Deals only. An unreleased game has nothing on sale, so it has no entry —
     which is correct, not a failure, and is why a miss renders as "not on sale
     anywhere yet" rather than an error.
   ══════════════════════════════════════════════════════════════════════════ */

MT.cheapshark = (function () {
  const BASE = 'https://www.cheapshark.com/api/1.0';

  /* One request. The search response already carries `cheapest` and
     `cheapestDealID`, so asking for the full deal list as well would double
     the cost to add a store name nobody needs before they click. */
  async function lookup(opts) {
    opts = opts || {};
    const q = opts.steamAppId
      ? { steamAppID: String(opts.steamAppId) }
      : { title: opts.title || '', limit: 8 };
    if (!q.steamAppID && !q.title) return null;

    const rows = await MT.net.get('cheapshark', `${BASE}/games?${MT.net.qs(q)}`, {
      ttl: MT.TTL.price, signal: opts.signal, meta: opts.meta,
    });
    if (!Array.isArray(rows) || !rows.length) return null;

    const hit = q.steamAppID ? rows[0] : bestTitleMatch(rows, opts.title);
    if (!hit || hit.cheapest == null) return null;

    const price = Number(hit.cheapest);
    if (!isFinite(price)) return null;

    return {
      title: hit.external || opts.title || '',
      price,
      steamAppId: hit.steamAppID || opts.steamAppId || null,
      dealUrl: hit.cheapestDealID
        ? `https://www.cheapshark.com/redirect?dealID=${encodeURIComponent(hit.cheapestDealID)}`
        : null,
      fetchedAt: Date.now(),
    };
  }

  /* CheapShark's title search is loose — "chop chop" returns ChopChop, Chop
     Chop Princess and a dozen others. Reuse the app's own relevance scorer
     rather than trusting position, and refuse rather than guess when nothing
     is a convincing match: a wrong price is worse than no price. */
  function bestTitleMatch(rows, title) {
    if (!title) return null;
    let best = null;
    let bestScore = 0;
    for (const r of rows) {
      /* relevance() returns { score, coverage } — comparing the object itself
         yields NaN and quietly matches nothing. */
      const { score } = MT.util.relevance(title, r.external || '');
      if (score > bestScore) { bestScore = score; best = r; }
    }
    return bestScore >= 0.94 ? best : null;
  }

  async function verifyKey() {
    try {
      const r = await fetch(`${BASE}/stores`, { cache: 'no-store', credentials: 'omit' });
      return r.ok ? { ok: true } : { ok: false, reason: `CheapShark returned HTTP ${r.status}.` };
    } catch (_) {
      return { ok: false, reason: 'Could not reach CheapShark.' };
    }
  }

  return { lookup, verifyKey };
})();
