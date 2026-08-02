/* ══════════════════════════════════════════════════════════════════════════
   Wikidata — the game source that does not fall over.

   RAWG is the only browser-reachable API that can enumerate the long tail of
   upcoming games, and it goes down often. Wikidata cannot replace it: measured
   against the live endpoint, it holds roughly 295 games with a publication
   date across the next twelve months, where Steam ships that many in a month.
   It skews hard to titles somebody thought worth writing an article about.

   That is exactly why it is useful here. It guarantees the well-known releases
   are always visible, so an outage costs you the obscure end rather than the
   whole view.

   Three properties earn it a place:

   · No key, no registration, no quota, and `Access-Control-Allow-Origin: *`
     verified from both a served origin and file://.
   · Run by the Wikimedia Foundation. Not immune — this endpoint returned a 502
     during evaluation — but a different failure domain from RAWG, which is the
     whole point of having two.
   · Date PRECISION is a first-class field (9 = year, 10 = month, 11 = day)
     rather than something to infer from Jan-1 placeholders. For an app built
     around never overstating a date, that is better data than TMDB gives us.

   Notability is the sitelink count: how many Wikipedia language editions
   bother to cover the game. Measured, it separates cleanly — 30 for Hades,
   15 for Pentiment, 4 for Sir Brante, 3 for Peglin.
   ══════════════════════════════════════════════════════════════════════════ */

MT.wikidata = (function () {
  const ENDPOINT = 'https://query.wikidata.org/sparql';

  /* Wikimedia asks that clients identify themselves. A browser refuses to set
     User-Agent, so the contact goes in the query comment, which is the
     conventional fallback and does reach their logs. */
  const TAG = '#MovieTrak/0.1 personal watchlist (https://github.com/Ackley14/entertainmentwatch)';

  /* P31/P279* Q7889  instance of (a subclass of) video game
     P577            publication date
     P1733           Steam application ID — the join key to RAWG and CheapShark
     P400            platform
     Labels come from the label service, which needs an explicit language list;
     `mul` catches items labelled once for all languages, and without it a
     great many Japanese releases come back as bare Q-ids. */
  /* Written for SPEED, because the obvious formulation is unusable. Measured
     against the live endpoint for a one-month window:

       wdt:P31/wdt:P279* + platform GROUP_CONCAT ....  17-44s
       direct wdt:P31, truthy date filter first .....   7.2s   (same 55 rows)

     The service hard-times-out at 60 seconds, so the first version was dying
     outright a good share of the time and making a user wait three quarters of
     a minute when it did not.

     What made the difference:
       · `wdt:P31 wd:Q7889` instead of walking `wdt:P279*`. The transitive
         subclass closure over every video game is enormous, and costs a
         handful of items that are only an instance of some subclass.
       · Filtering on the TRUTHY `wdt:P577` first, which is indexed, and only
         then joining the statement node for precision. Reversed, the engine
         walks every publication-date statement in the graph before filtering.
       · No platforms. They were fetched for `gameExtra` and never displayed in
         a release row, and the OPTIONAL plus GROUP_CONCAT forced a GROUP BY
         over the whole result.

     P31   instance of (Q7889 video game)
     P577  publication date; the statement node carries wikibase:timePrecision
     P1733 Steam application ID -- the join key to RAWG and CheapShark */
  function windowQuery(fromISO, toISO, limit) {
    return `${TAG}
SELECT ?g ?gLabel ?date ?precision ?sitelinks ?steam WHERE {
  ?g wdt:P31 wd:Q7889 ; wdt:P577 ?d ; wikibase:sitelinks ?sitelinks .
  FILTER(?d >= "${fromISO}T00:00:00Z"^^xsd:dateTime && ?d <= "${toISO}T23:59:59Z"^^xsd:dateTime)
  ?g p:P577 ?stmt . ?stmt psv:P577 ?tv .
  ?tv wikibase:timeValue ?date ; wikibase:timePrecision ?precision .
  FILTER(?date = ?d)
  OPTIONAL { ?g wdt:P1733 ?steam }
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul". }
}
ORDER BY DESC(?sitelinks)
LIMIT ${limit || 120}`;
  }

  /* Wikidata's own precision codes, which map straight onto the app's model —
     no Jan-1 guessing required. Anything vaguer than a year is not a release
     date in any useful sense. */
  const PRECISION = { 11: 'day', 10: 'month', 9: 'year' };

  /* Latency here is wildly variable — the same query measured 2s, 7s and 44s
     on consecutive runs — so every call is bounded. This is a supplement; it
     is never worth making someone wait on it.

     Wide enough for one retry, because the service answers 502 in bursts and a
     tighter bound aborted the retry before it could succeed. */
  const TIMEOUT_MS = 20000;

  async function releasesBetween(fromISO, toISO, opts) {
    opts = opts || {};
    const url = `${ENDPOINT}?format=json&query=${encodeURIComponent(
      windowQuery(fromISO, toISO, opts.limit))}`;

    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), opts.timeout || TIMEOUT_MS);
    /* Honour a caller's own signal as well, so leaving the route still aborts. */
    if (opts.signal) opts.signal.addEventListener('abort', () => ctl.abort(), { once: true });

    let data;
    try {
      data = await MT.net.get('wikidata', url, {
        ttl: MT.TTL.wikidata,
        signal: ctl.signal,
        meta: opts.meta,
        headers: { Accept: 'application/sparql-results+json' },
      });
    } finally {
      clearTimeout(timer);
    }

    const rows = (data && data.results && data.results.bindings) || [];
    return rows.map(row).filter(Boolean);
  }

  function row(b) {
    const uri = b.g && b.g.value;
    if (!uri) return null;
    const qid = uri.slice(uri.lastIndexOf('/') + 1);
    const label = b.gLabel && b.gLabel.value;

    /* An item with no label in any requested language comes back as its own
       Q-id. Rendering "Q134739750" in a release list is worse than omitting
       it, and there is nothing useful to show alongside it either. */
    if (!label || /^Q\d+$/.test(label)) return null;

    const precision = PRECISION[Number(b.precision && b.precision.value)];
    if (!precision) return null;

    /* "2027-03-15T00:00:00Z" — sliced, never parsed. Constructing a Date from
       this and reading it back locally is how a March 15 release becomes
       March 14 for everyone west of Greenwich. */
    const iso = (b.date && b.date.value) || '';
    const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(iso);
    if (!m) return null;

    return {
      qid,
      name: label,
      parts: { y: +m[1], m: +m[2], d: +m[3] },
      precision,
      sitelinks: Number((b.sitelinks && b.sitelinks.value) || 0),
      steamAppId: (b.steam && b.steam.value) || null,
      platforms: ((b.platforms && b.platforms.value) || '').split(', ').filter(Boolean),
    };
  }

  /* No key to verify — reachability is the only question. */
  async function verifyKey() {
    try {
      const r = await fetch(`${ENDPOINT}?format=json&query=${encodeURIComponent(
        TAG + '\nSELECT ?x WHERE { BIND(1 AS ?x) }')}`,
        { cache: 'no-store', credentials: 'omit',
          headers: { Accept: 'application/sparql-results+json' } });
      return r.ok ? { ok: true } : { ok: false, reason: `Wikidata returned HTTP ${r.status}.` };
    } catch (_) {
      return { ok: false, reason: 'Could not reach Wikidata.' };
    }
  }

  return { releasesBetween, verifyKey, windowQuery, PRECISION };
})();
