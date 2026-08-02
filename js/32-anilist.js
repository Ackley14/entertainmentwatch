/* ══════════════════════════════════════════════════════════════════════════
   AniList — anime enrichment. No key, CORS-open, GraphQL over POST.

   Anime is a FACET here, not a fourth kind. An anime series exists in both
   TMDB and AniList, so treating AniList as its own media type puts the same
   show in the library twice and forces a ~7.5 MB id-mapping blob to fix it.

   Instead: the item stays a TMDB record, and the first time you open an anime
   detail page we search AniList once by title and year, then cache the id on
   the record forever. Zero shipped data, no duplicates, one request per title
   for the lifetime of the entry.

   AniList's docs currently warn the API is degraded and capped at 30 requests
   per minute, so the net policy throttles it hard and it is never on a
   critical path.
   ══════════════════════════════════════════════════════════════════════════ */

MT.anilist = (function () {
  const ENDPOINT = 'https://graphql.anilist.co';

  const MEDIA_FIELDS = `
    id idMal title { romaji english native }
    format status episodes duration season seasonYear
    averageScore meanScore popularity favourites
    genres
    tags { id name rank isGeneralSpoiler isMediaSpoiler category }
    studios(isMain: true) { nodes { id name } }
    staff(perPage: 6) { edges { role node { id name { full } } } }
    source
    startDate { year month day }
    endDate { year month day }
    nextAiringEpisode { episode airingAt timeUntilAiring }
    siteUrl
    recommendations(sort: RATING_DESC, perPage: 12) {
      nodes { rating mediaRecommendation { id title { romaji english } siteUrl averageScore } }
    }
  `;

  async function gql(query, variables, opts) {
    return MT.net.post('anilist', ENDPOINT, { query, variables }, {
      ttl: MT.TTL.anilist,
      signal: opts && opts.signal,
      headers: { 'Accept': 'application/json' },
    });
  }

  /* Search by title + year. AniList's romaji/english/native split means a
     TMDB title may match any of the three, so we let AniList's own search
     ranking decide rather than trying to match strings ourselves. */
  async function findByTitle(title, year, opts) {
    if (!title) return null;
    const query = `
      query ($search: String, $year: Int) {
        Page(perPage: 5) {
          media(search: $search, type: ANIME, seasonYear: $year, sort: SEARCH_MATCH) { ${MEDIA_FIELDS} }
        }
      }`;
    try {
      let data = await gql(query, { search: title, year: year || undefined }, opts);
      let list = MT.util.deepGet(data, 'data.Page.media', []);
      if (!list.length && year) {
        /* AniList's seasonYear is the season a show started, which disagrees
           with TMDB's first_air_date across a New Year often enough to matter. */
        data = await gql(`
          query ($search: String) {
            Page(perPage: 5) { media(search: $search, type: ANIME, sort: SEARCH_MATCH) { ${MEDIA_FIELDS} } }
          }`, { search: title }, opts);
        list = MT.util.deepGet(data, 'data.Page.media', []);
      }
      return list[0] || null;
    } catch (e) {
      console.debug('[anilist] search failed (non-fatal)', e && e.message);
      return null;
    }
  }

  async function byId(id, opts) {
    try {
      const data = await gql(`query ($id: Int) { Media(id: $id, type: ANIME) { ${MEDIA_FIELDS} } }`,
        { id }, opts);
      return MT.util.deepGet(data, 'data.Media', null);
    } catch (e) { return null; }
  }

  /* Fold AniList data into an existing TMDB-backed item. Returns true when
     something actually changed, so the caller knows whether to persist. */
  function enrich(item, media) {
    if (!item || !media) return false;
    item.ids = item.ids || {};
    item.ids.anilist = media.id;
    item.ids.mal = media.idMal || null;
    item.links = item.links || {};
    item.links.anilist = media.siteUrl || `https://anilist.co/anime/${media.id}`;
    if (media.idMal) item.links.mal = `https://myanimelist.net/anime/${media.idMal}`;

    if (media.averageScore != null) {
      item.ratings = item.ratings || {};
      item.ratings.anilist = {
        score: media.averageScore, scale: 100,
        votes: media.popularity || null,
        fetchedAt: Date.now(), url: media.siteUrl,
      };
    }

    /* AniList tags carry a `rank` (0-100) expressing how strongly the tag
       applies — a genuinely better term weight than anything TMDB offers.
       Spoiler tags are dropped for two reasons: they spoil, and plot-reveal
       tags make terrible similarity features. */
    const tags = (media.tags || [])
      .filter(t => !t.isGeneralSpoiler && !t.isMediaSpoiler)
      .filter(t => (t.rank || 0) >= 60);

    item.rec = item.rec || { terms: {}, candidates: {} };
    item.rec.terms = item.rec.terms || {};
    for (const t of tags) item.rec.terms[`tag:anilist:${t.id}`] = (t.rank || 60) / 100;
    for (const s of MT.util.deepGet(media, 'studios.nodes', [])) {
      item.rec.terms[`co:anilist:${s.id}`] = 0.5;
    }
    for (const e of MT.util.deepGet(media, 'staff.edges', [])) {
      const role = /director/i.test(e.role || '') ? 'dir'
                 : /creator|original/i.test(e.role || '') ? 'dir' : 'oth';
      item.rec.terms[`p:${role}:anilist:${e.node.id}`] = role === 'dir' ? 1.0 : 0.35;
    }
    /* `source` (MANGA / LIGHT_NOVEL / ORIGINAL / VISUAL_NOVEL / GAME) is a
       six-value feature with no TMDB analogue and real predictive power —
       light-novel adaptations genuinely do feel like each other. */
    if (media.source) item.rec.terms[`src:anilist:${media.source}`] = 0.6;

    /* AniList's recommendations are human-curated rather than algorithmic,
       which makes them the highest-confidence graph signal in the app. */
    item.rec.candidates = item.rec.candidates || {};
    item.rec.candidates.anilist = MT.util.deepGet(media, 'recommendations.nodes', [])
      .filter(n => n.mediaRecommendation)
      .map(n => ({
        anilistId: n.mediaRecommendation.id,
        title: n.mediaRecommendation.title.english || n.mediaRecommendation.title.romaji,
        rating: n.rating || 0,
        url: n.mediaRecommendation.siteUrl,
        score: n.mediaRecommendation.averageScore,
      }));

    item.animeExtra = {
      format: media.format, status: media.status,
      episodes: media.episodes, durationMin: media.duration,
      season: media.season, seasonYear: media.seasonYear,
      source: media.source,
      studios: MT.util.deepGet(media, 'studios.nodes', []).map(s => s.name),
      nextAiring: media.nextAiringEpisode ? {
        episode: media.nextAiringEpisode.episode,
        airingAt: media.nextAiringEpisode.airingAt * 1000,
      } : null,
      fetchedAt: Date.now(),
    };
    return true;
  }

  /* Fetch-and-fold, used lazily when an anime detail page opens. */
  async function enrichItem(item, opts) {
    if (!item || !item.facets || !item.facets.anime) return false;
    const fresh = (item.animeExtra && item.animeExtra.fetchedAt) || 0;
    if (item.ids.anilist && Date.now() - fresh < MT.TTL.anilist) return false;

    const media = item.ids.anilist
      ? await byId(item.ids.anilist, opts)
      : await findByTitle(item.originalTitle || item.title,
          MT.util.sortKeyToParts(item.release && item.release.sortKey)?.y, opts);
    return enrich(item, media);
  }

  return { gql, findByTitle, byId, enrich, enrichItem };
})();
