/* ══════════════════════════════════════════════════════════════════════════
   RAWG client — games.

   IGDB would be the better source (it is the only game database with a real
   similarity graph) but it cannot be reached from a browser at all: a live
   preflight returns 401 with no access-control headers, and IGDB's own docs
   say "the API does not allow requests directly from browsers". Staying static
   means RAWG.

   The thing to know about RAWG: its ERROR responses come from Cloudflare with
   no CORS header, so the browser rejects them before any status is readable.
   A dead key and a dead network are the same exception. MT.net.classify()
   untangles that; everything here just has to not swallow it.
   ══════════════════════════════════════════════════════════════════════════ */

MT.rawg = (function () {
  const BASE = 'https://api.rawg.io/api';

  function url(path, params) {
    return `${BASE}${path}?${MT.net.qs(Object.assign({ key: MT.config.key('rawg') }, params || {}))}`;
  }

  function requireKey() {
    if (!MT.config.hasKey('rawg')) {
      throw new MT.net.NetError('auth',
        'Add a free RAWG key in Settings to search games.',
        { source: 'rawg', setup: true });
    }
  }

  async function search(query, opts) {
    requireKey();
    opts = opts || {};
    const data = await MT.net.get('rawg', url('/games', {
      search: query, page_size: opts.limit || 10, search_precise: true,
    }), { ttl: MT.TTL.search, signal: opts.signal });
    return data.results || [];
  }

  async function game(id, opts) {
    requireKey();
    opts = opts || {};
    return MT.net.get('rawg', url(`/games/${id}`), {
      ttl: MT.TTL.rawg, noCache: opts.fresh, signal: opts.signal,
    });
  }

  /* /games/{id}/suggested is business-tier only, and even then it is visual
     similarity computed from cover art rather than taste. game-series is the
     free substitute — but it only ever returns sequels and spin-offs, so it
     feeds a "more in this series" rail, never the main recommendation slate. */
  async function series(id) {
    requireKey();
    const data = await MT.net.get('rawg', url(`/games/${id}/game-series`, { page_size: 12 }),
      { ttl: MT.TTL.rawg });
    return data.results || [];
  }

  async function byFilters(params, opts) {
    requireKey();
    const data = await MT.net.get('rawg', url('/games', Object.assign({ page_size: 20 }, params)),
      { ttl: MT.TTL.rawg, signal: opts && opts.signal });
    return data.results || [];
  }

  /* ── Tag semantics probe ───────────────────────────────────────────────
     RAWG does not document whether a comma in `?tags=` means AND or OR, and it
     is the opposite of TMDB often enough that guessing is reckless: guess AND
     when it means OR and you get 400,000 irrelevant results; guess OR when it
     means AND and you get zero — which looks exactly like a broken key,
     because RAWG's errors arrive without CORS headers.

     So: measure it once, cache the answer forever. Two extra requests, paid
     once per browser. */
  async function tagSemantics() {
    const cached = await MT.repo.metaGet('rawg.tagSemantics');
    if (cached) return cached;
    try {
      const count = async params => {
        const d = await MT.net.get('rawg', url('/games', Object.assign({ page_size: 1 }, params)),
          { ttl: 30 * 86400000 });
        return d.count || 0;
      };
      const [a, b, both] = await Promise.all([
        count({ tags: 'atmospheric' }),
        count({ tags: 'souls-like' }),
        count({ tags: 'atmospheric,souls-like' }),
      ]);
      /* A union exceeds both operands; an intersection is smaller than both. */
      const verdict = (both > a && both > b) ? 'or' : (both < a && both < b) ? 'and' : 'and';
      await MT.repo.metaSet('rawg.tagSemantics', verdict);
      await MT.repo.metaSet('rawg.tagSemanticsEvidence', { a, b, both, at: Date.now() });
      console.info(`[rawg] tag semantics probe: ${a} / ${b} / ${both} → "${verdict}"`);
      return verdict;
    } catch (e) {
      console.warn('[rawg] tag probe failed, assuming AND', e);
      return 'and';
    }
  }

  /* Total catalogue size — the denominator for turning RAWG's `games_count`
     into a real IDF. RAWG hands us exact document frequency for free, which is
     the one place its data model beats TMDB's. */
  async function catalogueSize() {
    const cached = await MT.repo.metaGet('rawg.N');
    if (cached) return cached;
    try {
      const d = await MT.net.get('rawg', url('/games', { page_size: 1 }), { ttl: 30 * 86400000 });
      const n = d.count || 500000;
      await MT.repo.metaSet('rawg.N', n);
      return n;
    } catch (_) { return 500000; }
  }

  async function verifyKey(key) {
    try {
      const res = await fetch(`${BASE}/games?key=${encodeURIComponent(key)}&page_size=1`,
        { cache: 'no-store', credentials: 'omit' });
      if (res.ok) return { ok: true };
      return { ok: false, reason: `RAWG returned HTTP ${res.status}.` };
    } catch (e) {
      /* Opaque by design — RAWG's failures carry no CORS header, so the browser
         hides the status. Use TMDB as a control to tell "offline" from "bad key". */
      const online = await MT.net.probeInternet();
      return { ok: false, reason: online
        ? 'RAWG rejected that key (or the monthly quota is spent). The browser cannot see which — RAWG sends errors without CORS headers.'
        : 'Could not reach the internet.' };
    }
  }

  return { url, search, game, series, byFilters, tagSemantics, catalogueSize, verifyKey, requireKey };
})();
