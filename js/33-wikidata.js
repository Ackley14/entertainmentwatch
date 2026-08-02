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
  function windowQuery(fromISO, toISO, limit) {
    return `${TAG}
SELECT ?g ?gLabel ?date ?precision ?sitelinks ?steam
       (GROUP_CONCAT(DISTINCT ?platformLabel; separator=", ") AS ?platforms) WHERE {
  ?g wdt:P31/wdt:P279* wd:Q7889 .
  ?g p:P577 ?stmt .
  ?stmt psv:P577 ?tv .
  ?tv wikibase:timeValue ?date .
  ?tv wikibase:timePrecision ?precision .
  ?g wikibase:sitelinks ?sitelinks .
  OPTIONAL { ?g wdt:P1733 ?steam }
  OPTIONAL { ?g wdt:P400 ?platform . ?platform rdfs:label ?platformLabel . FILTER(LANG(?platformLabel) = "en") }
  FILTER(?date >= "${fromISO}T00:00:00Z"^^xsd:dateTime && ?date <= "${toISO}T23:59:59Z"^^xsd:dateTime)
  SERVICE wikibase:label { bd:serviceParam wikibase:language "en,mul,ja,de,fr". }
}
GROUP BY ?g ?gLabel ?date ?precision ?sitelinks ?steam
ORDER BY DESC(?sitelinks) ?date
LIMIT ${limit || 120}`;
  }

  /* Wikidata's own precision codes, which map straight onto the app's model —
     no Jan-1 guessing required. Anything vaguer than a year is not a release
     date in any useful sense. */
  const PRECISION = { 11: 'day', 10: 'month', 9: 'year' };

  async function releasesBetween(fromISO, toISO, opts) {
    opts = opts || {};
    const url = `${ENDPOINT}?format=json&query=${encodeURIComponent(
      windowQuery(fromISO, toISO, opts.limit))}`;

    const data = await MT.net.get('wikidata', url, {
      ttl: MT.TTL.wikidata,
      signal: opts.signal,
      meta: opts.meta,
      headers: { Accept: 'application/sparql-results+json' },
    });

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
