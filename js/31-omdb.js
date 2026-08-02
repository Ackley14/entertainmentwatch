/* ══════════════════════════════════════════════════════════════════════════
   OMDb client — the bridge to IMDb, Rotten Tomatoes and Metacritic.

   This is how a real IMDb rating reaches the app: TMDB gives us the `tt…` id,
   OMDb turns that id into IMDb / RT / Metascore numbers.

   Treat it as fragile. OMDb's changelog stops in 2019, its issue tracker has
   an unanswered "Is OMDb abandoned?" thread from late 2025, and it
   redistributes RT and Metacritic data it has no license for. It works today.
   It must never block a render, and when it dies the app loses three rating
   sources and nothing else.
   ══════════════════════════════════════════════════════════════════════════ */

MT.omdb = (function () {
  const BASE = 'https://www.omdbapi.com/';

  const SOURCE_IMDB = 'Internet Movie Database';
  const SOURCE_RT   = 'Rotten Tomatoes';
  const SOURCE_MC   = 'Metacritic';

  /* A rejected key would otherwise be re-tried on every single item view,
     burning the daily allowance on requests that cannot succeed. Once OMDb
     tells us the key is bad we stop asking until the key actually changes —
     the flag is keyed on the value, so pasting a new one clears it. */
  let rejectedKey = null;
  const keyRejected = () => rejectedKey && rejectedKey === MT.config.key('omdb');

  async function byImdbId(imdbId, opts) {
    if (!imdbId || !MT.config.hasKey('omdb') || keyRejected()) return null;
    opts = opts || {};
    const key = MT.config.key('omdb');
    const u = `${BASE}?${MT.net.qs({ apikey: key, i: imdbId, r: 'json' })}`;
    try {
      const raw = await MT.net.get('omdb', u, { ttl: MT.TTL.omdb, signal: opts.signal });
      if (!raw || raw.Response === 'False') {
        /* OMDb reports a bad key as a 200 with Response:"False", so the status
           code alone never reveals it — the body has to be read. */
        if (/invalid api key|no api key/i.test(raw && raw.Error || '')) {
          rejectedKey = key;
          console.warn('[omdb] key rejected — IMDb, Rotten Tomatoes and Metacritic scores are unavailable until it is fixed in Settings');
        }
        return null;
      }
      return parseRatings(raw);
    } catch (e) {
      if (e && e.kind === 'auth') rejectedKey = key;
      /* Absence is the expected outcome often enough that it is not an error. */
      console.debug('[omdb] lookup failed (non-fatal)', e && e.message);
      return null;
    }
  }

  /* Missing sources are OMITTED from the Ratings array — they are never present
     as "N/A". So Ratings[1] is Rotten Tomatoes for one film and Metacritic for
     another, and positional access silently mislabels scores. Always look up
     by Source string. */
  function parseRatings(raw) {
    const find = s => (raw.Ratings || []).find(r => r.Source === s);
    const out = { fetchedAt: Date.now() };

    /* `imdbRating` arrives as the literal string "N/A" when absent, and
       parseFloat("N/A") is NaN — which propagates silently into the quality
       prior and then into Array.sort, producing an arbitrary ordering with no
       error anywhere. Guard at the boundary, never downstream. */
    const imdbScore = num(raw.imdbRating);
    if (imdbScore != null) {
      out.imdb = {
        score: imdbScore, scale: 10,
        votes: int(raw.imdbVotes),          // arrives comma-formatted: "1,234,567"
        fetchedAt: Date.now(),
        url: raw.imdbID ? `https://www.imdb.com/title/${raw.imdbID}/` : null,
      };
    }

    const rt = find(SOURCE_RT);
    if (rt && rt.Value) {
      const pct = int(rt.Value.replace('%', ''));
      if (pct != null) out.rottenTomatoes = { score: pct, scale: 100, kind: 'critics', fetchedAt: Date.now() };
    }

    const mcRaw = find(SOURCE_MC);
    const mcScore = mcRaw ? int(String(mcRaw.Value).split('/')[0]) : num(raw.Metascore);
    if (mcScore != null) out.metacritic = { score: mcScore, scale: 100, fetchedAt: Date.now() };

    void find(SOURCE_IMDB);      // already covered by the top-level imdbRating
    return out;
  }

  function num(v) {
    if (v == null || v === 'N/A' || v === '') return null;
    const n = parseFloat(String(v).replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  function int(v) {
    const n = num(v);
    return n == null ? null : Math.round(n);
  }

  /* RT and Metacritic coverage is effectively movies-only. Knowing that lets
     the UI distinguish structural absence ("RT doesn't rate television") from
     situational absence ("no RT score for this film yet") — the first should
     render nothing at all, the second a muted dash. */
  function coversRtMetacritic(kind) { return kind === 'movie'; }

  async function verifyKey(key) {
    try {
      const res = await fetch(`${BASE}?apikey=${encodeURIComponent(key)}&i=tt0111161&r=json`,
        { cache: 'no-store', credentials: 'omit' });
      const body = await res.json().catch(() => null);
      if (body && body.Response === 'True') { rejectedKey = null; return { ok: true }; }
      const err = (body && body.Error) || `OMDb returned HTTP ${res.status}.`;
      if (/invalid api key/i.test(err)) {
        rejectedKey = key;
        return { ok: false, reason: 'OMDb rejected that key. New keys need activating — check your email for the link OMDb sends and click it, then test again.' };
      }
      return { ok: false, reason: err };
    } catch (e) {
      return { ok: false, reason: 'Could not reach OMDb.' };
    }
  }

  return { byImdbId, parseRatings, coversRtMetacritic, verifyKey, keyRejected };
})();
