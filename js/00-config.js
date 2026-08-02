/* ══════════════════════════════════════════════════════════════════════════
   MovieTrak — configuration
   Loaded first. Defines the single global `MT` namespace.
   ══════════════════════════════════════════════════════════════════════════ */

window.MT = window.MT || {};

/* ── API KEYS ──────────────────────────────────────────────────────────────
   Paste your keys between the quotes below and commit the file. They become
   publicly readable — that is a deliberate, accepted trade for zero setup.
   Anything set in Settings is stored in this browser only and WINS over the
   baked value, so you can override a rate-limited key without editing code.

   TMDB   (required) — free, instant:  https://www.themoviedb.org/settings/api
   OMDb   (optional) — IMDb/RT/Metacritic scores, 1,000/day:
                                       https://www.omdbapi.com/apikey.aspx
   RAWG   (optional) — games, 20,000/month:  https://rawg.io/apidocs
   AniList / TVmaze  — no key required.
   ────────────────────────────────────────────────────────────────────────── */
MT.BAKED_KEYS = {
  tmdb: '6817ca06fecc9c774787441ab046e93d',
  omdb: '278454c9',
  rawg: 'a6cd69b57635443fbcb2b71712dd60bf',
};

MT.config = (function () {
  const LS_SETTINGS = 'mt.settings.v1';

  const DEFAULTS = {
    language: 'en-US',
    region: 'US',
    includeAdult: false,
    novelty: 0.25,          // "surprise me" weight in the recommender
    myProviders: [],        // TMDB provider ids the user subscribes to
    kinds: { movie: true, tv: true, game: true },
    keys: { tmdb: '', omdb: '', rawg: '' },
  };

  let settings = load();

  function load() {
    try {
      const raw = localStorage.getItem(LS_SETTINGS);
      if (!raw) return structuredCloneSafe(DEFAULTS);
      const parsed = JSON.parse(raw);
      return Object.assign(structuredCloneSafe(DEFAULTS), parsed, {
        keys: Object.assign({}, DEFAULTS.keys, parsed.keys || {}),
        kinds: Object.assign({}, DEFAULTS.kinds, parsed.kinds || {}),
      });
    } catch (_) {
      return structuredCloneSafe(DEFAULTS);
    }
  }

  function structuredCloneSafe(o) { return JSON.parse(JSON.stringify(o)); }

  function save() {
    try { localStorage.setItem(LS_SETTINGS, JSON.stringify(settings)); }
    catch (e) { console.warn('[config] could not persist settings', e); }
  }

  return {
    /* Override (this browser) beats baked (the repo). */
    key(source) {
      const own = (settings.keys && settings.keys[source] || '').trim();
      return own || (MT.BAKED_KEYS[source] || '').trim();
    },
    hasKey(source) { return !!this.key(source); },
    /* True when the key in play came from Settings rather than the repo. */
    keyIsLocal(source) { return !!(settings.keys && (settings.keys[source] || '').trim()); },
    setKey(source, value) {
      settings.keys = settings.keys || {};
      settings.keys[source] = (value || '').trim();
      save();
    },

    get(k) { return settings[k]; },
    set(k, v) { settings[k] = v; save(); },
    all() { return settings; },
    /* Export/import moves settings but NEVER keys — allow-list, not deny-list. */
    exportable() {
      return {
        language: settings.language,
        region: settings.region,
        includeAdult: settings.includeAdult,
        novelty: settings.novelty,
        myProviders: settings.myProviders,
        kinds: settings.kinds,
      };
    },
    importSettings(obj) {
      if (!obj || typeof obj !== 'object') return;
      const allow = ['language', 'region', 'includeAdult', 'novelty', 'myProviders', 'kinds'];
      for (const k of allow) if (k in obj) settings[k] = obj[k];
      save();
    },
    reset() { settings = structuredCloneSafe(DEFAULTS); save(); },
  };
})();

/* ── Network policy, per source ───────────────────────────────────────────
   TMDB's real ceiling is ~40 req/s and it is enforced PER CLIENT IP, which we
   share with the user's own browsing — so we self-cap well below it.
   RAWG's cap is per MONTH, which is why it gets a budget rather than a rate. */
/* Each source is throttled according to what it actually enforces — verified
   against the providers' own pages, because the three limits are very
   different in kind and treating them alike wastes the tight ones.

   TMDB   — no request quota at all, only a rate ceiling (~40/s, per client IP).
            Rate-limited, not budgeted.
   OMDb   — 1,000 per DAY on the free tier, and it is the one that will
            actually run out. Used as sparingly as possible: only when an item
            page is opened, never on add, never during a background sweep.
   RAWG   — "up to 20,000 requests per month" on the Free plan (rawg.io/apidocs).
            A daily sub-cap stops one bad afternoon eating the month. */
MT.NET_POLICY = {
  tmdb:    { rps: 20, concurrency: 6, retries: 3, dailyBudget: null, monthlyBudget: null },
  omdb:    { rps: 2,  concurrency: 1, retries: 1, dailyBudget: 250,  monthlyBudget: null },
  rawg:    { rps: 4,  concurrency: 3, retries: 2, dailyBudget: 600,  monthlyBudget: 19000 },
  anilist: { rps: 0.4, concurrency: 1, retries: 2, dailyBudget: null, monthlyBudget: null },
};

/* ── Cache TTLs (ms) ──────────────────────────────────────────────────────
   HARD_TTL is a compliance ceiling, not a tuning knob: TMDB's terms forbid
   caching their data beyond six months. Boot purges anything older. */
const DAY = 86400000;
MT.TTL = {
  search:       10 * 60 * 1000,
  details:      3 * DAY,
  person:       7 * DAY,
  providers:    3 * DAY,
  /* Long on purpose. An IMDb score moves in the third decimal place over a
     month, and OMDb is the only genuinely scarce key — a 60-day cache means a
     200-title library costs a couple of hundred lookups every two months
     rather than a couple of hundred every fortnight. */
  omdb:         60 * DAY,
  anilist:      14 * DAY,
  rawg:         7 * DAY,
  /* The rec slate is additionally invalidated whenever the library changes,
     so a long TTL costs nothing in freshness — it only stops the ~35-request
     rebuild from firing on a timer while your taste has not moved. */
  recSlate:     14 * DAY,
  HARD_TTL:     150 * DAY,
};

/* ── Refresh tiers ────────────────────────────────────────────────────────
   Governs how often a tracked item is re-checked. Keeps a 1999 film from
   being polled like one releasing next week. */
MT.TIERS = {
  T0: { ttl: 6 * 3600e3, weight: 8 },    // imminent
  T1: { ttl: 1 * DAY,    weight: 4 },    // near, or currently airing
  T2: { ttl: 7 * DAY,    weight: 2 },    // dated, far out
  T3: { ttl: 14 * DAY,   weight: 1 },    // undated / speculative
  T4: { ttl: 90 * DAY,   weight: 0.2 },  // settled history
  T5: { ttl: Infinity,   weight: 0 },    // user stopped tracking
};

MT.SWEEP = {
  cooldownMs: 4 * 3600e3,     // auto-sweeps no more often than this
  autoBudget: { tmdb: 60, rawg: 8, omdb: 20, anilist: 2 },
  manualBudget: { tmdb: 220, rawg: 20, omdb: 60, anilist: 6 },
  hiddenMsBeforeRecheck: 30 * 60 * 1000,
};

/* ── Recommender constants ────────────────────────────────────────────────
   Deterministic arithmetic only. TMDB's terms forbid using their data with
   any ML/AI application, so there is no model here and never will be. */
MT.REC = {
  facetWeight: { kw: 0.55, ppl: 0.30, gen: 0.10, co: 0.05 },
  graphQ: { recommendations: 0.30, similar: 0.22, anilist: 0.35 },
  contentVsGraph: { content: 0.72, graph: 0.28 },
  minVotes:  { movie: 250, tv: 60, game: 40 },
  priorMean: { movie: 6.3, tv: 6.7, game: 3.4 },
  qualityFloor: 0.35,
  mmrLambda: 0.30,
  caps: { franchise: 2, director: 3, company: 5 },
  minContentScore: 0.04,
  slate: 24,
  castDecay: r => 0.9 * Math.exp(-r / 3),
};

/* ── RAWG tag stoplist ────────────────────────────────────────────────────
   RAWG's tag vocabulary is polluted with store/platform metadata that has
   nothing to do with taste. These have MODERATE document frequency, so IDF
   actively promotes the rarer ones — without this list, recommendations decay
   into "other games that also have Steam Trading Cards".
   This list is a permanent maintenance burden. Add to it when you see junk. */
MT.RAWG_TAG_STOPLIST = new Set([
  'steam-achievements', 'steam-cloud', 'steam-trading-cards', 'steam-workshop',
  'steam-leaderboards', 'steam-turn-notifications', 'stats', 'achievements',
  'full-controller-support', 'partial-controller-support', 'controller-support',
  'captions-available', 'subtitles', 'family-sharing', 'in-app-purchases',
  'cross-platform-multiplayer', 'remote-play-on-tv', 'remote-play-on-phone',
  'remote-play-on-tablet', 'remote-play-together', 'includes-level-editor',
  'includes-source-sdk', 'valve-anti-cheat-enabled', 'vr-supported',
  'commentary-available', 'downloadable-content', 'mmo', 'shared-split-screen',
  'online-multiplayer', 'online-co-op', 'multiplayer', 'singleplayer',
  'cloud-saves', 'game-demo', 'xbox-live', 'steam-vr-collectibles',
]);
/* Anything appearing on more than this share of RAWG's catalogue is treated as
   structural rather than descriptive, whatever its name. */
MT.RAWG_TAG_DF_CUT = 0.08;

/* ── TMDB fixed vocabulary ────────────────────────────────────────────── */
MT.TMDB_RELEASE_TYPE = {
  1: 'premiere', 2: 'limited', 3: 'theatrical', 4: 'digital', 5: 'physical', 6: 'tv',
};

MT.IMG = {
  base: 'https://image.tmdb.org/t/p/',   /* no API key required for images */
  poster: { sm: 'w154', md: 'w342', lg: 'w500' },
  backdrop: { md: 'w780', lg: 'w1280' },
  profile: { sm: 'w45', md: 'w185' },
  logo: { sm: 'w45', md: 'w92' },
};

MT.LIMITS = {
  driftHistory: 20,
  feedPrimary: 50,
  searchResults: 30,
  backupNagDays: 7,
};
