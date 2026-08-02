# Decisions

Things that were settled deliberately, with the reason. Change them if the
reason stops holding — but read the reason first.

## Constraints these all follow from

1. **IMDb cannot be a data source.** `datasets.imdbws.com` sends no CORS headers
   (verified), the official API is AWS Data Exchange only, and imdb.com's
   robots.txt is an allowlist ending in `Disallow: /`. TMDB is the backbone;
   IMDb appears via `imdb_id`, OMDb and deep links.
2. **A public repo cannot hide a key.** Not with `.env`, not with an Actions
   secret injected at build. Anything the browser sends, a visitor can read.
3. **A static page has no memory between visits.** Release drift is a *stateful*
   comparison, so it is done by diffing against a snapshot in IndexedDB when the
   app opens.

## Architecture

**D1 — Item identity is `<kind>:<source>:<id>`.** `movie:tmdb:550`,
`tv:tmdb:1396`, `game:rawg:3498`. TMDB's movie and TV id spaces overlap
completely, so `tmdb:550` is ambiguous. The uid is immutable — it is the foreign
key in snapshots, alerts, follows, the URL and every alert id. All mutable id
mapping lives in the `idIndex` store.

**D2 — Anime is a facet, not a kind.** An anime series exists in both TMDB and
AniList; making it a fourth kind puts it in the library twice and the standard
fix is a ~7.5 MB id-mapping blob. Instead it is a TMDB record flagged by genre
16 + Japanese origin, and AniList data is fetched lazily on first view and
cached on the record.

**D3 — There is no `release.date`.** Precision is first class:
`day|month|quarter|year|tba|unknown`, plus an integer `sortKey` with sentinels
for the undated. A bare date field invites `if (item.release.date)`, which
erases the difference between "no date" and "sometime in 2027".

**D4 — Two alert stores.** `alertKeys` is an append-only content-addressed
ledger (dedupe); `feedItems` is mutable and coalesced (rendering). They cannot
be one store: content-addressing needs immutability, coalescing needs mutation.

**D5 — Everything goes through `MT.repo`.** Views, sync, alerts and the
recommender never touch `MT.db`. That single seam is what let encrypted GitHub
sync be added without a rewrite.

**D6 — `MT.net` is the only caller of `fetch()`** (except the three
`verifyKey` probes, which deliberately bypass caching and budgets). One place
for the rate limiter, cache, retries, budget and error classifier.

**D7 — The recommender is arithmetic, not a model.** TF-IDF, cosine, Bayesian
shrinkage, greedy MMR. TMDB's terms forbid using their data "in connection with,
including for training, a machine learning (ML) or artificial intelligence (AI)
based Application" — so the compliance line printed under the recommendations is
literally true, and must stay true.

**D8 — Classic `<script>` tags, no modules, no build.** `<script type="module">`
is hard-blocked by CORS on `file://` in every modern browser, which would kill
double-click-to-open. Numeric load order, one `MT` global.

**D9 — Encrypt the library; do not store a password.** A hash in a public repo
is an offline cracking target, and the check would run in JavaScript the visitor
controls. AES-GCM's authentication tag failing on a wrong-key decrypt *is* the
login, and it cannot be bypassed because there is nothing to bypass.
PBKDF2-SHA256 at 600,000 iterations (OWASP guidance; WebCrypto has no Argon2).

**D10 — Import and cloud-restore are replace-only.** Merging divergent libraries
is a real distributed-systems problem; guessing silently would be worse than
making the choice explicit.

## Verified live (2026-08-01), not assumed

| Claim | Result |
|---|---|
| TMDB sends `ACAO: *` on preflight and on errors, from `Origin: null` | confirmed — `file://` works |
| RAWG error responses carry **no** CORS header | confirmed — a dead key is indistinguishable from being offline without `diagnose()` |
| IGDB blocks browsers outright | confirmed by their docs and a 401-with-no-ACAO preflight |
| IndexedDB round-trips on `file://` (Chromium) | confirmed |
| WebCrypto available on `file://` | confirmed |
| `api.github.com` allows cross-origin `PUT` with `Authorization` | confirmed by GitHub's docs + live preflight |

## Open

- **RAWG tag semantics (AND vs OR)** — undocumented and possibly the opposite of
  TMDB's. `MT.rawg.tagSemantics()` measures it once at runtime with two probe
  requests and caches the verdict, rather than guessing. Guessing wrong yields
  either 400k irrelevant results or zero, and zero looks exactly like a bad key.
- **The RAWG tag stoplist** in `00-config.js` is a permanent maintenance burden
  and the single biggest quality lever on the game side. RAWG's vocabulary is
  full of store metadata (`Steam Trading Cards`, `Full controller support`) with
  moderate document frequency, which IDF actively *promotes*. Add to it when you
  see junk in the taste profile on `#/stats`.

## Deferred

AMC ticket integration (their `/views/embargoed` endpoint really does return a
first-party `visibilityDateTimeUtc` on-sale timestamp, but needs a ~10-day key
approval and covers only AMC) · Trakt · TVmaze episode data · a shipped global
IDF table · provider-change alerts · light theme.
