# MovieTrak

A watchlist for films, television, games and anime. One list, real release
dates, ratings from several places, and recommendations built from your own
taste. No accounts, no server, no build step — it is plain HTML that runs
either from a web address or by double-clicking `index.html`.

**Live:** https://ackley14.github.io/entertainmentwatch/

---

## Read this first: it does not search IMDb

IMDb has no free API. Their data exports send no CORS headers, so a browser
physically cannot read them; the official API is sold through AWS Data Exchange
at enterprise prices; and scraping imdb.com is barred by their robots.txt.

So **search is powered by [TMDB](https://www.themoviedb.org/)** — but every
result carries its IMDb id, which means each title still shows a real **IMDb
rating** (fetched from OMDb using that id) and links straight to its IMDb page.
The app feels IMDb-native. It just isn't IMDb-powered.

TMDB's search is good, and its television coverage is better than you'd expect.

---

## Setup

The app needs one free API key to do anything. The rest are optional and each
unlocks a feature.

| Key | Needed for | Free tier | Get one |
|---|---|---|---|
| **TMDB** | everything: search, metadata, recommendations | unlimited-ish | [themoviedb.org/settings/api](https://www.themoviedb.org/settings/api) |
| OMDb | IMDb / Rotten Tomatoes / Metacritic scores | 1,000 per day | [omdbapi.com/apikey.aspx](https://www.omdbapi.com/apikey.aspx) |
| RAWG | video games | 20,000 per month | [rawg.io/apidocs](https://rawg.io/apidocs) |
| AniList | anime scores and recommendations | no key needed | — |

There are two ways to supply them:

1. **Paste them into Settings.** Stored in that browser only, never committed,
   never included in exports. Do this on each machine.
2. **Commit them.** Put them in `MT.BAKED_KEYS` at the top of
   [`js/00-config.js`](js/00-config.js) and push. Zero setup afterwards, but the
   keys become publicly readable — anyone can use them and burn the quota, and
   GitHub's secret scanner may email you about it. A key pasted in Settings
   always overrides a committed one, so you can fix a rate-limited key without
   editing code.

## Running it

**Locally** — double-click `index.html`. That's it; there is nothing to install
or compile.

**On GitHub Pages** — push to `main`, then **Settings → Pages → Source: Deploy
from a branch → `main` / `(root)`**. It is live a minute later, and every
subsequent push redeploys.

> `file://` and your published site are separate browser origins, so they keep
> **separate libraries**. Move between them with the passphrase sync below, or
> with Export/Import.

---

## Sync across machines

Your library is encrypted **in the browser** and committed to this repository as
`data/library.enc.json`. Enter the same passphrase anywhere else and everything
comes back.

There is no password stored anywhere — not even a hash. The passphrase derives
an AES-256 key via PBKDF2 (600,000 iterations); if the file decrypts, the
passphrase was right. That is why publishing the file is safe, and also why
**there is no way to recover a forgotten passphrase.** Keep it in your password
manager.

To enable publishing you need a GitHub token, created once per machine:

1. [Create a fine-grained token](https://github.com/settings/personal-access-tokens/new)
2. Repository access: **Only select repositories** → this one
3. Permissions: **Contents → Read and write**
4. Set an expiry date
5. Paste it into Settings → Sync

Reading needs no token at all — the file is public, and it is ciphertext.

> The token can write to the repository that serves this page, so anyone who
> stole it could also commit code into the site. Scope it to this one
> repository, give it an expiry, and remove it from machines you don't control.

---

## What it does

- **Search** across films, television and games in one box. Press `/` from
  anywhere, type, press `Enter` to add the top hit.
- **Release dates with honest precision.** A title known only to "2027" is never
  shown as January 1st. `Jul 16, 2027` / `July 2027` / `Q3 2027` / `2027` / `TBA`
  / `Rumoured` all look different and are grouped differently.
- **Coming Up** — a timeline where vaguer dates sit in their own strips rather
  than being given invented days.
- **Unannounced titles** — TMDB's Rumoured/Planned statuses, plus *following*
  directors, actors and studios, which is how you hear about a film before it
  has a date at all.
- **Activity feed** — release dates appearing, moving, being pulled; new seasons;
  next episodes; titles arriving on streaming services.
- **Recommendations** with reasons: *"Because you liked Sicario and Prisoners —
  shares Denis Villeneuve, moral ambiguity."* Computed on your device.
- **Ratings** from IMDb, TMDB, Rotten Tomatoes, Metacritic, AniList and RAWG,
  each shown in its own units and never averaged together — a Tomatometer (share
  of critics who were positive) and a Metascore (weighted quality average) are
  not the same kind of number.
- **Stats** that double as a readable view of your taste profile.

## What it does not do

- **Ticket sales.** No cinema chain offers a free, browser-reachable showtimes
  API. The app flags when a release date firms up, which historically precedes
  booking by a few weeks, and says so in exactly those terms. It never claims
  tickets are on sale.
- **Good game recommendations.** IGDB is the only game database with a real
  similarity graph and it blocks browser requests outright. Games fall back to
  tag overlap, which is noticeably rougher than the film side.
- **Cross-media suggestions.** TMDB keywords, AniList tags and RAWG tags are
  different vocabularies with no reliable mapping, and TMDB's terms forbid using
  their data with any ML model — so this is a contractual limit, not just a
  technical one.
- **Push notifications.** Nothing here runs while the app is closed. Changes are
  detected when you open it.

---

## Your data

Everything lives in this browser's IndexedDB. That makes it fast and private,
and it also means **clearing site data erases it** — as does Safari, which
deletes local storage for sites you have not visited in seven days.

Export is one click and is the only real backup. The app nags after a week.

## Layout

```
index.html          the whole app shell
css/                tokens, base, components, per-view layout
js/00-05            config, date/text utilities, the single network layer
js/10-16            IndexedDB, the repository facade, encryption, GitHub sync
js/20-38            TMDB / RAWG / OMDb / AniList clients, and normalization
js/40-48            recommender, change detection, refresh scheduling
js/49-70            router, shared components, one file per screen
```

Classic `<script>` tags in numeric order, one `MT` global. No modules — they are
blocked on `file://`, which would break double-click-to-open.

## Attribution

This website uses TMDB and the TMDB APIs but is not endorsed, certified, or
otherwise approved by TMDB. Streaming availability by JustWatch. Game data by
[RAWG](https://rawg.io/). Ratings via [OMDb](https://www.omdbapi.com/). Anime
data by [AniList](https://anilist.co/).

TMDB, OMDb and RAWG's free tier are all **non-commercial use only**, which
includes ad revenue. This is a personal tool and needs to stay one.
