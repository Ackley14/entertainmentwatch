/* ══════════════════════════════════════════════════════════════════════════
   TMDB client — the backbone. Search, details, discover, people, collections.

   Two things here are load-bearing and easy to get wrong:

   1. `append_to_response` collapses seven requests into one. Detail fetches
      return keywords, credits, recommendations, similar, external_ids, watch
      providers and release dates in a single round trip. For a 200-item
      library that is 200 requests instead of 1,400.

   2. Movie details carry `imdb_id` at the top level. TV details DO NOT — it
      lives only under `external_ids`, and the failure is silent: IMDb ratings
      simply never appear for television and nothing errors. Both kinds always
      request external_ids, and the normalizer asserts it arrived.
   ══════════════════════════════════════════════════════════════════════════ */

MT.tmdb = (function () {
  const BASE = 'https://api.themoviedb.org/3';

  function url(path, params) {
    const p = Object.assign({
      api_key: MT.config.key('tmdb'),
      language: MT.config.get('language') || 'en-US',
    }, params || {});
    return `${BASE}${path}?${MT.net.qs(p)}`;
  }

  function requireKey() {
    if (!MT.config.hasKey('tmdb')) {
      throw new MT.net.NetError('auth',
        'MovieTrak needs a TMDB API key to search. Add one in Settings — it is free and takes about a minute.',
        { source: 'tmdb', setup: true });
    }
  }

  const APPEND_MOVIE = 'keywords,credits,recommendations,similar,external_ids,watch/providers,release_dates,videos';
  const APPEND_TV    = 'keywords,aggregate_credits,recommendations,similar,external_ids,watch/providers,content_ratings,videos';

  /* ── Search ────────────────────────────────────────────────────────────
     /search/multi returns movies, TV and people in one call, and — unlike
     /discover — it DOES return unreleased and undated titles. That matters:
     discover has no status filter and anchors every query on dates, so a film
     with status "Planned" and no release date is unreachable through it.
     Search is the only way to add something the day it's announced. */
  async function searchMulti(query, opts) {
    requireKey();
    opts = opts || {};
    const data = await MT.net.get('tmdb', url('/search/multi', {
      query,
      include_adult: MT.config.get('includeAdult') ? 'true' : 'false',
      page: opts.page || 1,
    }), { ttl: MT.TTL.search, signal: opts.signal });
    return (data.results || []).filter(r => r.media_type === 'movie' || r.media_type === 'tv');
  }

  /* Per-kind search, for the category tabs. /search/multi is still used for
     the "All" tab because it is one request instead of two. */
  async function searchKind(kind, query, opts) {
    requireKey();
    opts = opts || {};
    const data = await MT.net.get('tmdb', url(`/search/${kind === 'tv' ? 'tv' : 'movie'}`, {
      query,
      include_adult: MT.config.get('includeAdult') ? 'true' : 'false',
      page: opts.page || 1,
    }), { ttl: MT.TTL.search, signal: opts.signal });
    return (data.results || []).map(r => Object.assign({ media_type: kind }, r));
  }

  async function searchPerson(query, opts) {
    requireKey();
    opts = opts || {};
    const data = await MT.net.get('tmdb', url('/search/person', { query, page: 1 }),
      { ttl: MT.TTL.search, signal: opts.signal });
    return data.results || [];
  }

  async function searchCompany(query, opts) {
    requireKey();
    opts = opts || {};
    const data = await MT.net.get('tmdb', url('/search/company', { query, page: 1 }),
      { ttl: MT.TTL.search, signal: opts.signal });
    return data.results || [];
  }

  /* ── Details ──────────────────────────────────────────────────────────── */
  async function details(kind, id, opts) {
    requireKey();
    opts = opts || {};
    const path = kind === 'tv' ? `/tv/${id}` : `/movie/${id}`;
    const raw = await MT.net.get('tmdb', url(path, {
      append_to_response: kind === 'tv' ? APPEND_TV : APPEND_MOVIE,
    }), { ttl: MT.TTL.details, noCache: opts.fresh, cacheClass: 'raw', signal: opts.signal });

    /* Fail loudly rather than silently losing IMDb linkage for all television. */
    if (kind === 'tv' && !raw.external_ids) {
      throw new Error('TMDB tv details fetched without external_ids — append_to_response is wrong');
    }
    return raw;
  }

  /* ── Discover ─────────────────────────────────────────────────────────
     THE syntax trap: a comma is AND, a pipe is OR.
     `with_keywords=a,b,c` demands all three and returns almost nothing;
     `with_keywords=a|b|c` is what a taste profile actually wants.
     And `sort_by=vote_average.desc` without a vote_count floor returns
     single-vote 10/10 shorts, so a floor is always applied. */
  async function discover(kind, params, opts) {
    requireKey();
    opts = opts || {};
    const p = Object.assign({
      include_adult: MT.config.get('includeAdult') ? 'true' : 'false',
      'vote_count.gte': MT.REC.minVotes[kind === 'tv' ? 'tv' : 'movie'],
      page: 1,
    }, params);
    const data = await MT.net.get('tmdb',
      url(kind === 'tv' ? '/discover/tv' : '/discover/movie', p),
      { ttl: MT.TTL.search, signal: opts.signal });
    return (data.results || []).map(r => Object.assign({ media_type: kind }, r));
  }

  const OR = ids => ids.filter(x => x != null).join('|');   // OR
  const AND = ids => ids.filter(x => x != null).join(',');  // AND

  /* ── People & companies ───────────────────────────────────────────────
     combined_credits is one request covering film AND television, and it
     includes unreleased and completely undated projects. This is the single
     best mechanism for learning that a film exists before it has a date —
     one call per followed director beats polling a dozen tracked items. */
  async function personCredits(personId, opts) {
    requireKey();
    opts = opts || {};
    return MT.net.get('tmdb', url(`/person/${personId}/combined_credits`), {
      ttl: MT.TTL.person, noCache: opts.fresh, signal: opts.signal,
    });
  }

  async function person(personId, opts) {
    requireKey();
    return MT.net.get('tmdb', url(`/person/${personId}`), {
      ttl: MT.TTL.person, signal: opts && opts.signal,
    });
  }

  async function companyReleases(companyId, opts) {
    requireKey();
    opts = opts || {};
    const results = [];
    for (const kind of ['movie', 'tv']) {
      try {
        const r = await discover(kind, {
          [kind === 'tv' ? 'with_companies' : 'with_companies']: companyId,
          sort_by: 'primary_release_date.desc',
          'vote_count.gte': 0,
        }, opts);
        results.push(...r);
      } catch (e) { console.warn('[tmdb] company discover failed', e); }
    }
    return results;
  }

  async function collection(collectionId, opts) {
    requireKey();
    return MT.net.get('tmdb', url(`/collection/${collectionId}`), {
      ttl: MT.TTL.details, signal: opts && opts.signal,
    });
  }

  async function providerList(kind) {
    requireKey();
    const data = await MT.net.get('tmdb', url(`/watch/providers/${kind === 'tv' ? 'tv' : 'movie'}`, {
      watch_region: MT.config.get('region') || 'US',
    }), { ttl: MT.TTL.providers });
    return data.results || [];
  }

  /* ── Releases in a date window ─────────────────────────────────────────
     Measured against the live API, an unfiltered week returns 319 films. Most
     are festival entries, regional releases and titles with no distribution at
     all. Three levers cut that down, and each is chosen rather than guessed:

     · with_original_language=en          319 -> 158
     · region=US + with_release_type      158 ->  57   (an actual US release)
     · a notability floor, applied by the caller relative to the window's own
       median, because popularity is TIME-RELATIVE and no fixed number works:
       this week's top film scores 15.3, next month's 46.8, and a year out the
       entire top five sits between 1.6 and 2.0 — and that five is Turtles,
       Bluey and Narnia, i.e. exactly what you want to see.

     Release types 3|2|4 are theatrical, limited and digital. Digital is
     included deliberately: plenty of real releases now skip cinemas, and
     leaving it out hides them.

     THE TRAP: with `region` set, TMDB filters on the REGIONAL release date but
     still returns `release_date` as the PRIMARY one. A re-release therefore
     comes back looking like a 1971 film releasing next Friday (Willy Wonka
     does exactly this). The caller must verify each date against the window.

     Always sorted popularity.desc. That is what makes paging terminate: once
     results fall below the floor, everything after them does too, so the
     caller can stop. Chronological display is a client-side re-sort of a set
     that is small and bounded precisely because of that floor. */
  async function releasesBetween(kind, fromISO, toISO, opts) {
    requireKey();
    opts = opts || {};
    const tv = kind === 'tv' || kind === 'anime';
    const p = {
      'vote_count.gte': 0,
      sort_by: 'popularity.desc',
      include_adult: MT.config.get('includeAdult') ? 'true' : 'false',
      page: opts.page || 1,
    };

    if (tv) {
      p['first_air_date.gte'] = fromISO;
      p['first_air_date.lte'] = toISO;
    } else {
      /* release_date rather than primary_release_date, because only the
         regional field respects region + with_release_type. */
      p['release_date.gte'] = fromISO;
      p['release_date.lte'] = toISO;
      p.region = MT.config.get('region') || 'US';
      p.with_release_type = '3|2|4';
    }

    /* Anime is a facet, not a kind — matched the way 38-normalize does it. It
       is Japanese by definition, so the English filter must not apply. */
    if (kind === 'anime') {
      p.with_genres = 16;
      p.with_origin_country = 'JP';
    } else {
      p.with_original_language = 'en';
    }

    const data = await MT.net.get('tmdb', url(tv ? '/discover/tv' : '/discover/movie', p),
      { ttl: MT.TTL.search, signal: opts.signal, meta: opts.meta });
    return {
      results: (data.results || []).map(r => Object.assign({ media_type: tv ? 'tv' : 'movie' }, r)),
      page: data.page || 1,
      /* TMDB reports a total_pages far past what it will serve — page 501 is a
         hard error regardless of the count it quotes. */
      totalPages: Math.min(data.total_pages || 1, 500),
      total: data.total_results || 0,
    };
  }

  async function trending(window_) {
    requireKey();
    const data = await MT.net.get('tmdb', url(`/trending/all/${window_ || 'week'}`), { ttl: MT.TTL.search });
    return (data.results || []).filter(r => r.media_type === 'movie' || r.media_type === 'tv');
  }

  /* ── Images ────────────────────────────────────────────────────────────
     image.tmdb.org needs no API key at all, so posters keep working even when
     the key is missing or rate-limited. Paths are stored, never full URLs —
     TMDB retires size buckets and a stored URL would rot. */
  function img(path, size) {
    if (!path) return null;
    return MT.IMG.base + (size || MT.IMG.poster.md) + path;
  }

  /* Verify a key without spending anything meaningful. */
  async function verifyKey(key) {
    const testUrl = `${BASE}/configuration?api_key=${encodeURIComponent(key)}`;
    try {
      const res = await fetch(testUrl, { cache: 'no-store', credentials: 'omit' });
      if (res.ok) return { ok: true };
      if (res.status === 401) return { ok: false, reason: 'That key was rejected by TMDB.' };
      return { ok: false, reason: `TMDB returned HTTP ${res.status}.` };
    } catch (e) {
      return { ok: false, reason: 'Could not reach TMDB — check your connection.' };
    }
  }

  return {
    url, searchMulti, searchKind, searchPerson, searchCompany, details, discover, OR, AND,
    personCredits, person, companyReleases, collection, providerList, trending,
    releasesBetween,
    img, verifyKey, requireKey,
    APPEND_MOVIE, APPEND_TV,
  };
})();
