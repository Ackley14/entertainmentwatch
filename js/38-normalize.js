/* ══════════════════════════════════════════════════════════════════════════
   Normalization — the single choke point where remote data may touch a record.

   Every source (TMDB movie, TMDB tv, RAWG, AniList) arrives with a different
   id space, a different rating scale and a different idea of what a release
   date is. They all leave here as one shape. Nothing outside this file is
   allowed to read a raw API payload into an item.

   Item identity is `<kind>:<source>:<id>` — three parts, never two. TMDB's
   movie and TV id spaces overlap completely, so `tmdb:550` is both Fight Club
   and an unrelated series. The uid is immutable once assigned: it is the
   foreign key in snapshots, alerts, follows, the URL and every alert id.
   ══════════════════════════════════════════════════════════════════════════ */

MT.normalize = (function () {

  const uidOf = (kind, source, id) => `${kind}:${source}:${id}`;

  function parseUid(uid) {
    const [kind, source, ...rest] = String(uid).split(':');
    return { kind, source, id: rest.join(':') };
  }

  /* ── Release model ─────────────────────────────────────────────────────
     Precision is first class. There is no `release.date` field anywhere in the
     app, deliberately — a bare date invites `if (item.release.date)`, which
     erases the difference between "no date" and "sometime in 2027". */

  function emptyRelease(status) {
    return {
      status: status || 'unannounced',
      precision: 'unknown',
      raw: '', display: 'No date',
      sortKey: MT.util.SK_UNKNOWN,
      confidence: 0.1, inferred: 0,
      region: MT.config.get('region') || 'US',
      type: null, windows: [], history: [],
    };
  }

  const CONFIDENCE = { day: 1, month: 0.8, quarter: 0.6, year: 0.4, tba: 0.1, unknown: 0.1 };

  function buildRelease(rawDate, opts) {
    opts = opts || {};
    const released = opts.status === 'released' || opts.status === 'ended' || opts.status === 'ongoing';
    const der = MT.util.derivePrecision(rawDate, { released, tba: opts.tba });
    const rel = emptyRelease(opts.status);
    rel.precision = der.precision;
    rel.inferred = der.inferred;
    rel.raw = rawDate || '';
    rel.sortKey = MT.util.sortKeyOf(der.parts, der.precision);
    rel.display = MT.util.displayRelease(der.parts, der.precision);
    rel.confidence = CONFIDENCE[der.precision] || 0.1;
    rel.region = opts.region || MT.config.get('region') || 'US';
    rel.type = opts.type || null;
    rel.windows = opts.windows || [];
    return rel;
  }

  /* TMDB's production status strings → our ladder. The interesting values are
     the early ones: "Rumored" and "Planned" are precisely the titles the user
     means when they say "unannounced". */
  const TMDB_STATUS = {
    'Rumored': 'unannounced',
    'Planned': 'announced',
    'In Production': 'in_production',
    'Post Production': 'post_production',
    'Released': 'released',
    'Canceled': 'cancelled',
    'Cancelled': 'cancelled',
    'Returning Series': 'ongoing',
    'Ended': 'ended',
    'Pilot': 'in_production',
  };
  const STATUS_RANK = {
    unannounced: 1, announced: 2, in_production: 3, post_production: 4,
    released: 5, ongoing: 5, ended: 6, cancelled: 0,
  };

  /* Pick the release window that matters to this user: their own region's
     theatrical/digital date, falling back to the primary release. */
  function pickReleaseWindow(releaseDates, region) {
    if (!releaseDates || !releaseDates.results) return null;
    const wanted = releaseDates.results.find(r => r.iso_3166_1 === region);
    const pool = wanted || releaseDates.results[0];
    if (!pool || !pool.release_dates || !pool.release_dates.length) return null;

    const windows = [];
    for (const rd of pool.release_dates) {
      const type = MT.TMDB_RELEASE_TYPE[rd.type] || 'theatrical';
      const raw = (rd.release_date || '').slice(0, 10);
      const der = MT.util.derivePrecision(raw, { released: false });
      windows.push({
        type, region: pool.iso_3166_1, precision: der.precision, raw,
        sortKey: MT.util.sortKeyOf(der.parts, der.precision),
        note: rd.note || '',
      });
    }
    windows.sort((a, b) => a.sortKey - b.sortKey);
    /* Theatrical (or the earliest public window) is what a user is waiting on. */
    const primary = windows.find(w => w.type === 'theatrical')
                 || windows.find(w => w.type === 'limited')
                 || windows[0];
    return { primary, windows };
  }

  /* ── TMDB → item ──────────────────────────────────────────────────── */

  function fromTmdb(raw, kind) {
    const isTv = kind === 'tv';
    const region = MT.config.get('region') || 'US';

    /* TV details never carry imdb_id at the top level. This is the one place
       that difference is handled; getting it wrong means television silently
       loses its IMDb rating and its IMDb link. */
    const ext = raw.external_ids || {};
    const imdb = isTv ? (ext.imdb_id || null) : (raw.imdb_id || ext.imdb_id || null);

    const status = TMDB_STATUS[raw.status] || (isTv ? 'ongoing' : 'released');

    let release;
    if (isTv) {
      release = buildRelease(raw.first_air_date, { status, region, type: 'tv' });
      if (raw.next_episode_to_air && raw.next_episode_to_air.air_date) {
        const nx = buildRelease(raw.next_episode_to_air.air_date, { status, region, type: 'tv' });
        if (nx.sortKey >= MT.util.todaySortKey()) release = nx;
      }
    } else {
      const win = pickReleaseWindow(raw.release_dates, region);
      if (win && win.primary && win.primary.raw) {
        release = buildRelease(win.primary.raw, { status, region, type: win.primary.type });
        release.windows = win.windows;
      } else {
        release = buildRelease(raw.release_date, { status, region, type: 'theatrical' });
      }
    }
    release.statusRank = STATUS_RANK[status] != null ? STATUS_RANK[status] : 5;

    const credits = isTv ? (raw.aggregate_credits || raw.credits || {}) : (raw.credits || {});
    const people = extractPeople(credits, isTv);
    const genres = (raw.genres || []).map(g => ({ id: g.id, name: g.name, source: 'tmdb' }));
    const keywords = ((raw.keywords && (raw.keywords.keywords || raw.keywords.results)) || [])
      .map(k => ({ id: k.id, name: k.name, source: 'tmdb' }));

    const companies = []
      .concat((raw.production_companies || []).map(c => ({ id: c.id, name: c.name, role: 'production', source: 'tmdb' })))
      .concat((raw.networks || []).map(c => ({ id: c.id, name: c.name, role: 'network', source: 'tmdb' })));

    const providers = extractProviders(raw['watch/providers'], region);

    const item = {
      uid: uidOf(kind, 'tmdb', raw.id),
      kind,
      /* Anime is a facet, not a kind. Making it a kind means the same series
         exists twice — once from TMDB, once from AniList — and the library
         shows duplicates. Genre 16 plus a Japanese origin is the flag. */
      facets: { anime: isAnime(raw, genres) ? 1 : 0 },

      ids: {
        tmdb: raw.id, tmdbType: kind, imdb,
        rawg: null, rawgSlug: null, anilist: null,
        tvdb: ext.tvdb_id || null,
      },

      title: isTv ? (raw.name || raw.original_name) : (raw.title || raw.original_title),
      originalTitle: isTv ? raw.original_name : raw.original_title,
      overview: raw.overview || '',
      tagline: raw.tagline || '',
      homepage: raw.homepage || '',

      images: {
        posterPath: raw.poster_path || null,
        backdropPath: raw.backdrop_path || null,
        source: 'tmdb',
      },

      genres, keywords, people, companies,

      runtimeMin: isTv
        ? (Array.isArray(raw.episode_run_time) && raw.episode_run_time[0]) || null
        : raw.runtime || null,
      countries: (raw.production_countries || []).map(c => c.iso_3166_1),
      languages: [raw.original_language].filter(Boolean),
      certification: extractCertification(raw, region, isTv),

      release,

      ratings: {
        tmdb: raw.vote_count
          ? { score: raw.vote_average, scale: 10, votes: raw.vote_count, fetchedAt: Date.now(),
              url: `https://www.themoviedb.org/${kind}/${raw.id}` }
          : undefined,
      },

      providers,

      links: {
        tmdb: `https://www.themoviedb.org/${kind}/${raw.id}`,
        imdb: imdb ? `https://www.imdb.com/title/${imdb}/` : null,
        /* Letterboxd resolves TMDB ids directly, so this one is derivable.
           Wikipedia is NOT derivable from anything TMDB returns — so there is
           no Wikipedia link rather than a guessed one that 404s. */
        letterboxd: kind === 'movie' ? `https://letterboxd.com/tmdb/${raw.id}/` : null,
        rawg: null, steam: null, anilist: null,
      },

      tvExtra: isTv ? {
        seasonCount: raw.number_of_seasons || 0,
        episodeCount: raw.number_of_episodes || 0,
        episodeRunMin: (Array.isArray(raw.episode_run_time) && raw.episode_run_time[0]) || null,
        inProduction: raw.in_production ? 1 : 0,
        lastAirDate: raw.last_air_date || null,
        nextEpisode: raw.next_episode_to_air ? {
          season: raw.next_episode_to_air.season_number,
          episode: raw.next_episode_to_air.episode_number,
          name: raw.next_episode_to_air.name,
          airDate: raw.next_episode_to_air.air_date,
        } : null,
      } : undefined,

      rec: {
        fetchedAt: Date.now(),
        franchiseKey: raw.belongs_to_collection ? `tmdbcol:${raw.belongs_to_collection.id}` : null,
        terms: buildTerms({ genres, keywords, people, companies }),
        /* Summaries, not bare ids. TMDB's recommendations/similar arrays
           already carry title, poster, date and votes — everything a poster
           card needs. Storing only the id meant re-fetching each candidate
           just to draw it, which cost a dozen requests every time an item
           page opened. Keeping the summary makes "If you like this" free. */
        candidates: {
          recommendations: summarize(raw.recommendations, kind),
          similar: summarize(raw.similar, kind),
        },
        seedEligible: 1,
      },

      meta: {
        schema: 1, primarySource: 'tmdb',
        detailsFetchedAt: Date.now(),
        normalizerVersion: 1, partial: 0, manualOverrides: {},
      },
    };

    return item;
  }

  /* Compact enough to store on every item without bloating IndexedDB, complete
     enough that `candidateToStub` can render a card with no network at all. */
  function summarize(block, parentKind) {
    return ((block && block.results) || []).slice(0, 20).map(r => {
      const k = r.media_type === 'tv' ? 'tv' : r.media_type === 'movie' ? 'movie' : parentKind;
      return {
        id: r.id, kind: k,
        title: k === 'tv' ? (r.name || r.original_name) : (r.title || r.original_title),
        posterPath: r.poster_path || null,
        date: (k === 'tv' ? r.first_air_date : r.release_date) || '',
        score: r.vote_average || null,
        votes: r.vote_count || 0,
        genreIds: r.genre_ids || [],
      };
    });
  }

  /* Turn a stored candidate summary back into something renderable. */
  function candidateToStub(c) {
    const release = buildRelease(c.date, {});
    return {
      uid: uidOf(c.kind, 'tmdb', c.id),
      kind: c.kind,
      facets: { anime: 0 },
      ids: { tmdb: c.id, tmdbType: c.kind, imdb: null },
      title: c.title || `#${c.id}`,
      overview: '',
      images: { posterPath: c.posterPath, backdropPath: null, source: 'tmdb' },
      genres: (c.genreIds || []).map(id => ({ id, name: '', source: 'tmdb' })),
      keywords: [], people: [], companies: [],
      release,
      ratings: c.score ? { tmdb: { score: c.score, scale: 10, votes: c.votes,
                                  url: `https://www.themoviedb.org/${c.kind}/${c.id}` } } : {},
      links: { tmdb: `https://www.themoviedb.org/${c.kind}/${c.id}` },
      rec: { terms: {}, candidates: {}, seedEligible: 0 },
      meta: { schema: 1, primarySource: 'tmdb', detailsFetchedAt: 0, partial: 1, manualOverrides: {} },
    };
  }

  function isAnime(raw, genres) {
    const animation = (genres || []).some(g => g.id === 16);
    if (!animation) return false;
    const jp = (raw.original_language === 'ja')
      || (raw.origin_country || []).includes('JP')
      || (raw.production_countries || []).some(c => c.iso_3166_1 === 'JP');
    return !!jp;
  }

  function extractPeople(credits, isTv) {
    const out = [];
    const crew = credits.crew || [];
    for (const c of crew) {
      const job = c.job || (c.jobs && c.jobs[0] && c.jobs[0].job) || '';
      let role = null;
      if (job === 'Director') role = 'director';
      else if (job === 'Screenplay' || job === 'Writer' || job === 'Story') role = 'writer';
      else if (job === 'Original Music Composer' || job === 'Music') role = 'composer';
      else if (job === 'Director of Photography') role = 'cinematographer';
      if (role) out.push({ id: c.id, name: c.name, role, order: 0, source: 'tmdb', profilePath: c.profile_path });
    }
    if (isTv) {
      for (const c of (credits.created_by || [])) {
        out.push({ id: c.id, name: c.name, role: 'creator', order: 0, source: 'tmdb', profilePath: c.profile_path });
      }
    }
    const cast = (credits.cast || []).slice(0, 12);
    cast.forEach((c, i) => {
      out.push({
        id: c.id, name: c.name, role: 'cast', order: i, source: 'tmdb',
        profilePath: c.profile_path,
        character: c.character || (c.roles && c.roles[0] && c.roles[0].character) || '',
      });
    });
    return MT.util.uniqBy(out, p => `${p.role}:${p.id}`);
  }

  function extractCertification(raw, region, isTv) {
    const out = {};
    if (isTv) {
      const cr = (raw.content_ratings && raw.content_ratings.results) || [];
      const hit = cr.find(r => r.iso_3166_1 === region);
      if (hit && hit.rating) out[region] = hit.rating;
    } else {
      const rd = (raw.release_dates && raw.release_dates.results) || [];
      const hit = rd.find(r => r.iso_3166_1 === region);
      if (hit) {
        const cert = (hit.release_dates || []).map(x => x.certification).find(Boolean);
        if (cert) out[region] = cert;
      }
    }
    return out;
  }

  function extractProviders(wp, region) {
    if (!wp || !wp.results) return null;
    const r = wp.results[region];
    if (!r) return null;
    const map = list => (list || []).map(p => ({
      id: p.provider_id, name: p.provider_name, logoPath: p.logo_path,
    }));
    return {
      region, fetchedAt: Date.now(), expiresAt: Date.now() + MT.TTL.providers,
      link: r.link || null,
      flatrate: map(r.flatrate), free: map(r.free), ads: map(r.ads),
      rent: map(r.rent), buy: map(r.buy),
      attribution: 'JustWatch',
    };
  }

  /* ── Term vectors ──────────────────────────────────────────────────────
     Real term-frequency floats, not flat 1s. Cast decay has to be applied
     HERE, at normalize time, because billing order only exists in the source
     payload — by the time the recommender runs, that ordering is gone. */
  function buildTerms(parts) {
    const t = {};
    for (const k of parts.keywords || []) t[`kw:tmdb:${k.id}`] = 1.0;
    for (const g of parts.genres || []) t[`g:tmdb:${g.id}`] = 1.0;
    for (const p of parts.people || []) {
      if (p.role === 'cast') t[`p:cast:${p.id}`] = MT.REC.castDecay(p.order);
      else if (p.role === 'director' || p.role === 'creator') t[`p:dir:${p.id}`] = 1.0;
      else if (p.role === 'writer') t[`p:wri:${p.id}`] = 0.7;
      else t[`p:oth:${p.id}`] = 0.35;
    }
    for (const c of parts.companies || []) t[`co:tmdb:${c.id}`] = 0.5;
    for (const tag of parts.tags || []) t[`tag:${tag.slug || tag.id}`] = tag.weight != null ? tag.weight : 1.0;
    return t;
  }

  /* ── Search result → provisional item ─────────────────────────────────
     Adding from search must feel instant, so a stub is written immediately and
     the full detail fetch fills it in afterwards. `meta.partial` marks it. */
  function stubFromTmdbSearch(r) {
    const kind = r.media_type === 'tv' ? 'tv' : 'movie';
    const title = kind === 'tv' ? (r.name || r.original_name) : (r.title || r.original_title);
    const dateStr = kind === 'tv' ? r.first_air_date : r.release_date;
    const release = buildRelease(dateStr, { status: undefined });
    return {
      uid: uidOf(kind, 'tmdb', r.id),
      kind,
      facets: { anime: 0 },
      ids: { tmdb: r.id, tmdbType: kind, imdb: null, rawg: null, rawgSlug: null, anilist: null },
      title, originalTitle: kind === 'tv' ? r.original_name : r.original_title,
      overview: r.overview || '', tagline: '', homepage: '',
      images: { posterPath: r.poster_path || null, backdropPath: r.backdrop_path || null, source: 'tmdb' },
      genres: [], keywords: [], people: [], companies: [],
      runtimeMin: null, countries: [], languages: [], certification: {},
      release,
      ratings: r.vote_count
        ? { tmdb: { score: r.vote_average, scale: 10, votes: r.vote_count, fetchedAt: Date.now(),
                    url: `https://www.themoviedb.org/${kind}/${r.id}` } }
        : {},
      providers: null,
      links: {
        tmdb: `https://www.themoviedb.org/${kind}/${r.id}`,
        imdb: null,
        letterboxd: kind === 'movie' ? `https://letterboxd.com/tmdb/${r.id}/` : null,
      },
      rec: { fetchedAt: 0, franchiseKey: null, terms: {}, candidates: {}, seedEligible: 0 },
      meta: { schema: 1, primarySource: 'tmdb', detailsFetchedAt: 0,
              normalizerVersion: 1, partial: 1, manualOverrides: {} },
    };
  }

  /* ── RAWG → item ───────────────────────────────────────────────────── */

  function fromRawg(raw) {
    /* RAWG's `tba` flag is not the whole story — sentinel dates like 2099-12-31
       are real values in the catalogue, which derivePrecision also catches. */
    const release = buildRelease(raw.released, {
      status: raw.released && !raw.tba ? 'released' : 'announced',
      tba: !!raw.tba, type: 'game_launch',
    });
    release.statusRank = raw.released && !raw.tba ? 5 : 2;

    const tags = (raw.tags || [])
      .filter(t => !t.language || t.language === 'eng')
      .filter(t => !MT.RAWG_TAG_STOPLIST.has(t.slug))
      .slice(0, 30);

    const genres = (raw.genres || []).map(g => ({ id: `rawg:${g.id}`, name: g.name, source: 'rawg', gamesCount: g.games_count }));
    const devs = (raw.developers || []).map(d => ({ id: `rawg:${d.id}`, name: d.name, role: 'developer', source: 'rawg', gamesCount: d.games_count }));
    const pubs = (raw.publishers || []).map(p => ({ id: `rawg:${p.id}`, name: p.name, role: 'publisher', source: 'rawg' }));

    const steamStore = (raw.stores || []).find(s => s.store && s.store.slug === 'steam');
    const steamId = steamStore && steamStore.url ? (steamStore.url.match(/\/app\/(\d+)/) || [])[1] : null;

    const ratings = {};
    if (raw.rating && raw.ratings_count) {
      ratings.rawg = { score: raw.rating, scale: 5, votes: raw.ratings_count,
                       fetchedAt: Date.now(), url: `https://rawg.io/games/${raw.slug}` };
    }
    /* RAWG carries a Metacritic integer — the only compliant route to a
       Metascore for games, since Metacritic has no public API. */
    if (raw.metacritic) {
      ratings.metacritic = { score: raw.metacritic, scale: 100, fetchedAt: Date.now(),
                             url: raw.metacritic_url || null };
    }

    const playtime = raw.playtime || 0;
    const bucket = playtime < 2 ? '<2h' : playtime < 8 ? '2-8h' : playtime < 20 ? '8-20h'
                 : playtime < 60 ? '20-60h' : '60h+';

    const terms = buildTerms({
      genres, companies: devs.concat(pubs),
      tags: tags.map(t => ({ slug: t.slug, weight: 1.0 })),
    });
    if (playtime) terms[`play:${bucket}`] = 0.3;

    return {
      uid: uidOf('game', 'rawg', raw.id),
      kind: 'game',
      facets: { anime: 0 },
      ids: { tmdb: null, tmdbType: null, imdb: null, rawg: raw.id, rawgSlug: raw.slug, anilist: null, steam: steamId },
      title: raw.name,
      originalTitle: raw.name_original || raw.name,
      overview: (raw.description_raw || '').slice(0, 2000),
      tagline: '', homepage: raw.website || '',
      images: { posterPath: raw.background_image || null, backdropPath: raw.background_image_additional || null, source: 'rawg' },
      genres,
      keywords: tags.map(t => ({ id: `rawg:${t.slug}`, name: t.name, source: 'rawg', gamesCount: t.games_count })),
      people: [],
      companies: devs.concat(pubs),
      runtimeMin: null,
      countries: [], languages: [],
      certification: raw.esrb_rating ? { US: raw.esrb_rating.name } : {},
      release,
      ratings,
      providers: null,
      links: {
        rawg: `https://rawg.io/games/${raw.slug}`,
        steam: steamId ? `https://store.steampowered.com/app/${steamId}/` : null,
        tmdb: null, imdb: null, letterboxd: null,
      },
      gameExtra: {
        platforms: (raw.platforms || []).map(p => p.platform && p.platform.name).filter(Boolean),
        stores: (raw.stores || []).map(s => s.store && s.store.name).filter(Boolean),
        esrb: raw.esrb_rating ? raw.esrb_rating.name : null,
        playtimeHours: playtime, playtimeBucket: bucket,
        series: null, earlyAccess: 0,
      },
      rec: { fetchedAt: Date.now(), franchiseKey: null, terms, candidates: {}, seedEligible: 1 },
      meta: { schema: 1, primarySource: 'rawg', detailsFetchedAt: Date.now(),
              normalizerVersion: 1, partial: 0, manualOverrides: {} },
    };
  }

  function stubFromRawgSearch(r) {
    const release = buildRelease(r.released, { status: r.released && !r.tba ? 'released' : 'announced', tba: !!r.tba });
    return {
      uid: uidOf('game', 'rawg', r.id),
      kind: 'game',
      facets: { anime: 0 },
      ids: { rawg: r.id, rawgSlug: r.slug, tmdb: null, imdb: null, anilist: null },
      title: r.name, originalTitle: r.name, overview: '', tagline: '', homepage: '',
      images: { posterPath: r.background_image || null, backdropPath: null, source: 'rawg' },
      genres: (r.genres || []).map(g => ({ id: `rawg:${g.id}`, name: g.name, source: 'rawg' })),
      keywords: [], people: [], companies: [],
      runtimeMin: null, countries: [], languages: [], certification: {},
      release,
      ratings: r.metacritic ? { metacritic: { score: r.metacritic, scale: 100, fetchedAt: Date.now() } } : {},
      providers: null,
      links: { rawg: `https://rawg.io/games/${r.slug}` },
      gameExtra: { platforms: (r.platforms || []).map(p => p.platform && p.platform.name).filter(Boolean) },
      rec: { fetchedAt: 0, franchiseKey: null, terms: {}, candidates: {}, seedEligible: 0 },
      meta: { schema: 1, primarySource: 'rawg', detailsFetchedAt: 0,
              normalizerVersion: 1, partial: 1, manualOverrides: {} },
    };
  }

  /* ── Merge ─────────────────────────────────────────────────────────────
     Refreshed remote data must never clobber what the user typed, and must
     never clobber a field they corrected by hand. */
  function mergeItem(existing, fresh) {
    if (!existing) return fresh;
    const overrides = (existing.meta && existing.meta.manualOverrides) || {};

    /* A refresh that came back thin must never erase what we already know.
       Object.assign copies undefined values, so a partial or empty upstream
       payload — a rate-limited response, a truncated body, an outage that
       still returns 200 — would silently blank every field it omitted. A
       record with no title is the visible symptom; the same mechanism would
       quietly drop genres, credits and ids too.

       If the payload has no title at all it is not a usable record, so the
       refresh is discarded outright rather than merged. */
    if (!fresh || !fresh.title) return existing;

    const merged = Object.assign({}, existing, prune(fresh));

    /* User-authored state always wins. */
    merged.uid = existing.uid;
    merged.user = existing.user;
    merged.tracking = Object.assign({}, existing.tracking, {
      /* refresh bookkeeping is owned by the sync layer, not the payload */
      lastRefreshAt: Date.now(),
      consecutiveFetchErrors: 0,
      missSince: null,
    });

    /* Preserve drift history and any ids the fresh payload doesn't know. */
    merged.release = Object.assign({}, fresh.release, {
      history: (existing.release && existing.release.history) || [],
    });
    merged.ids = Object.assign({}, existing.ids, prune(fresh.ids));
    merged.links = Object.assign({}, existing.links, prune(fresh.links));
    merged.ratings = Object.assign({}, existing.ratings, prune(fresh.ratings));
    merged.meta = Object.assign({}, existing.meta, fresh.meta, {
      manualOverrides: overrides,
    });

    /* Anything the user edited by hand is restored on top. */
    for (const path of Object.keys(overrides)) setPath(merged, path, overrides[path]);
    return merged;
  }

  function prune(o) {
    const out = {};
    for (const [k, v] of Object.entries(o || {})) if (v != null) out[k] = v;
    return out;
  }

  function setPath(obj, path, value) {
    const parts = path.split('.');
    let cur = obj;
    for (let i = 0; i < parts.length - 1; i++) {
      if (cur[parts[i]] == null || typeof cur[parts[i]] !== 'object') cur[parts[i]] = {};
      cur = cur[parts[i]];
    }
    cur[parts[parts.length - 1]] = value;
  }

  /* ── What actually needs to travel ─────────────────────────────────────
     The synced file carries YOUR data. Everything else on a record came from
     an API and can be fetched again, so shipping it means paying for it in
     every commit forever — and because the file is encrypted, git cannot
     delta-compress successive versions, so each save stores a full fresh copy.

     Measured at 200 titles: 11.1 KB per item, of which rec.candidates alone
     was 5.6 KB and people/keywords/overview/companies another 3.1 KB. Dropping
     those is most of a 2.35 MB payload.

     rec.terms STAYS despite being derived: it is only ~800 B and it is what
     lets recommendations work on a new device before anything is re-fetched.

     `meta.partial` is set so the existing hydrate path refills the rest the
     first time you open the item — machinery that already exists for search
     stubs. */
  const SYNC_DROP = ['people', 'keywords', 'companies', 'overview', 'tagline',
                     'providers', 'idx', 'homepage', 'countries', 'languages'];

  function leanForSync(item) {
    const out = {};
    for (const [k, v] of Object.entries(item)) {
      if (SYNC_DROP.includes(k)) continue;
      out[k] = v;
    }
    out.genres = (item.genres || []).map(g => ({ id: g.id, name: g.name, source: g.source }));
    out.rec = {
      fetchedAt: 0,
      franchiseKey: item.rec && item.rec.franchiseKey,
      terms: (item.rec && item.rec.terms) || {},
      candidates: {},                       // the single biggest line item
      seedEligible: (item.rec && item.rec.seedEligible) || 0,
    };
    out.meta = Object.assign({}, item.meta, { partial: 1 });
    return out;
  }

  /* Bringing a synced record back in. If this device already holds the full
     record, keep the API-derived half and take only what the other device
     actually changed — otherwise every sync would throw away local detail and
     force a re-fetch of things we already had. */
  function absorbSynced(local, incoming) {
    if (!local || local.meta.partial) return incoming;
    const merged = Object.assign({}, local);
    merged.user = incoming.user;
    merged.tracking = incoming.tracking;
    merged.release = incoming.release || local.release;
    merged.ratings = Object.assign({}, local.ratings, prune(incoming.ratings));
    merged.ids = Object.assign({}, local.ids, prune(incoming.ids));
    merged.meta = Object.assign({}, local.meta, {
      manualOverrides: (incoming.meta && incoming.meta.manualOverrides) || local.meta.manualOverrides,
    });
    return merged;
  }

  /* A brand-new item needs default user state and refresh bookkeeping. */
  function withDefaults(item, status, source) {
    item.user = Object.assign({
      status: status || 'want', priority: 0, notes: '', tags: [],
      progress: null, addedAt: Date.now(), updatedAt: Date.now(),
      startedAt: null, finishedAt: null, source: source || 'search',
    }, item.user || {});
    item.tracking = Object.assign({
      watchReleaseFlag: 1, watchEpisodesFlag: 1,
      tier: 'T2', refreshDueAt: 0, lastRefreshAt: 0,
      consecutiveFetchErrors: 0, missSince: null, mutedFlag: 0,
    }, item.tracking || {});
    return item;
  }

  return {
    uidOf, parseUid, buildRelease, emptyRelease, buildTerms,
    summarize, candidateToStub,
    fromTmdb, stubFromTmdbSearch, fromRawg, stubFromRawgSearch,
    mergeItem, withDefaults, setPath, leanForSync, absorbSynced,
    TMDB_STATUS, STATUS_RANK,
  };
})();
