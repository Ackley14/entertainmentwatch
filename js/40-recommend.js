/* ══════════════════════════════════════════════════════════════════════════
   The recommender.

   Deterministic arithmetic — TF-IDF, cosine similarity, Bayesian shrinkage and
   greedy MMR selection. No model, no embeddings, no clustering. That is a
   contractual requirement as much as an architectural one: TMDB's terms forbid
   using their data "in connection with, including for training, a machine
   learning (ML) or artificial intelligence (AI) based Application". The line
   printed under the recommendations page is therefore literally true.

   Three stages:
     1. Profile  — one TF-IDF-weighted vector per media kind, built from the
                   library. Costs zero requests; the terms were captured when
                   each item was normalized.
     2. Candidates — the recommendations/similar arrays already sitting on each
                   item (free), plus a handful of profile-driven discover calls.
     3. Score    — content similarity × graph evidence × quality × novelty,
                   then a greedy diversity pass.

   The payoff for hand-rolling rather than just listing TMDB's endpoint is the
   reason string: because every score decomposes into per-seed contributions,
   the app can say WHY, and be telling the truth.
   ══════════════════════════════════════════════════════════════════════════ */

MT.rec = (function () {

  /* ── IDF ───────────────────────────────────────────────────────────────
     Computing IDF over the user's own library is exactly backwards: with a
     corpus of 200 films, the terms that define someone's taste are the ones
     that appear most, so they get the LOWEST weight.

     The fix is to accumulate document frequency from every payload the app
     ever touches — seeds, candidates, search results, detail views — counting
     each item once, ever. Laplace smoothing keeps an unseen term finite and
     always ≥ 1, so a brand-new term can never divide by zero or go negative.

     Genres self-correct without special-casing: there are only ~19 of them, so
     every genre accumulates enormous DF and lands at idf ≈ 1, contributing
     almost nothing discriminative. That is the correct behaviour. */
  function idfOf(dfTable, term) {
    const df = dfTable.map.get(term) || 0;
    return Math.log((dfTable.N + 1) / (df + 1)) + 1;
  }

  function facetOf(term) {
    if (term.startsWith('kw:') || term.startsWith('tag:') || term.startsWith('src:')) return 'kw';
    if (term.startsWith('p:')) return 'ppl';
    if (term.startsWith('g:')) return 'gen';
    if (term.startsWith('co:')) return 'co';
    if (term.startsWith('play:')) return 'kw';
    return 'kw';
  }

  /* ── Profile ───────────────────────────────────────────────────────────
     Seeds are weighted by how much the user liked them, and franchises are
     DAMPED rather than deduplicated: liking eight Marvel films really is more
     signal than liking one, just not eight times more, so a franchise of k
     items contributes k/√k = √k seed-units. Full dedupe throws information
     away; no damping lets one series define the whole profile. */
  function seedWeight(item) {
    let w = 1;
    if (item.user) {
      if (item.user.status === 'watched') w = 1.0;
      else if (item.user.status === 'watching') w = 0.9;
      else if (item.user.status === 'want') w = 0.7;      // aspiration, not evidence
      else if (item.user.status === 'dropped') w = 0.0;
      if (item.user.rating != null) {
        /* 10 → 1.6, 7 → 1.0, 5 → 0.6, 3 → 0.2 — a rated item outweighs an
           unrated one in both directions. */
        w *= MT.util.clamp(0.2 + (item.user.rating - 3) * 0.2, 0.05, 1.6);
      }
      if (item.user.priority) w *= 1 + item.user.priority * 0.1;
    }
    return w;
  }

  async function buildProfile(kind) {
    const all = await MT.repo.allItems();
    const dfTable = await MT.repo.dfTable();

    const seeds = all.filter(it =>
      it.kind === kind &&
      it.rec && it.rec.seedEligible &&
      it.user && it.user.status !== 'dropped' &&
      Object.keys(it.rec.terms || {}).length);

    if (!seeds.length) return { kind, empty: true, vec: {}, contrib: {}, seeds: [], N: 0 };

    /* Franchise damping. */
    const byFranchise = new Map();
    for (const s of seeds) {
      const key = s.rec.franchiseKey || s.uid;
      if (!byFranchise.has(key)) byFranchise.set(key, []);
      byFranchise.get(key).push(s);
    }
    const damp = new Map();
    for (const [key, group] of byFranchise) {
      const factor = group.length > 1 ? 1 / Math.sqrt(group.length) : 1;
      for (const s of group) damp.set(s.uid, factor);
      void key;
    }

    /* Accumulate, keeping a per-term → per-seed contribution map. That map is
       what later turns a score back into "because you liked X, Y and Z". */
    const raw = {};       // term -> summed weight
    const contrib = {};   // term -> { uid: weight }
    const seedInfo = [];

    for (const s of seeds) {
      const w = seedWeight(s) * (damp.get(s.uid) || 1);
      if (w <= 0) continue;
      seedInfo.push({ uid: s.uid, title: s.title, weight: w });
      for (const [term, tf] of Object.entries(s.rec.terms)) {
        const add = tf * w * idfOf(dfTable, term);
        raw[term] = (raw[term] || 0) + add;
        (contrib[term] = contrib[term] || {})[s.uid] = add;
      }
    }

    /* ── Per-facet L2 normalization ───────────────────────────────────────
       Each facet is normalized SEPARATELY. Under a single global norm, a
       documentary with 40 keywords and 2 credited people scores near zero
       against a blockbuster with 6 keywords and 15 people regardless of how
       similar they actually are — the cosine ends up measuring metadata
       density instead of taste. */
    const vec = normalizeByFacet(raw);

    return { kind, empty: false, vec, contrib, seeds: seedInfo, N: seeds.length, dfTable };
  }

  function normalizeByFacet(raw) {
    const norms = { kw: 0, ppl: 0, gen: 0, co: 0 };
    for (const [term, v] of Object.entries(raw)) norms[facetOf(term)] += v * v;
    for (const f of Object.keys(norms)) norms[f] = Math.sqrt(norms[f]) || 0;
    const out = {};
    for (const [term, v] of Object.entries(raw)) {
      const n = norms[facetOf(term)];
      out[term] = n > 0 ? v / n : 0;      // guard: never NaN
    }
    return out;
  }

  /* Cosine over sparse maps, per facet, then a weighted blend. Because both
     sides are already unit-normalized within each facet, the dot product IS
     the cosine. */
  function similarity(candTerms, profileVec, dfTable) {
    const cRaw = {};
    for (const [term, tf] of Object.entries(candTerms || {})) {
      cRaw[term] = tf * idfOf(dfTable, term);
    }
    const c = normalizeByFacet(cRaw);

    const dots = { kw: 0, ppl: 0, gen: 0, co: 0 };
    const hits = {};
    for (const [term, cv] of Object.entries(c)) {
      const pv = profileVec[term];
      if (!pv) continue;
      dots[facetOf(term)] += cv * pv;
      hits[term] = cv * pv;
    }
    const W = MT.REC.facetWeight;
    const score = W.kw * dots.kw + W.ppl * dots.ppl + W.gen * dots.gen + W.co * dots.co;
    return { score: Number.isFinite(score) ? score : 0, hits };
  }

  /* ── Graph evidence ────────────────────────────────────────────────────
     Candidates surfaced by TMDB's own recommendation/similar lists carry
     evidence independent of the vectors — actual co-watch behaviour. Combined
     with noisy-OR so that "five different seeds all point here" saturates
     toward 1 rather than summing past it. */
  function graphScore(sources) {
    let acc = 1;
    for (const s of sources) acc *= (1 - MT.util.clamp(s.q * s.seedWeight, 0, 0.95));
    return 1 - acc;
  }

  /* ── Quality prior ─────────────────────────────────────────────────────
     Bayesian shrinkage toward the corpus mean, then squashed into [floor, 1].
     The floor is load-bearing: without it quality dominates similarity and
     everyone gets recommended The Godfather. The ratio between best and worst
     is only ~2.9×, deliberately narrower than the dynamic range of similarity. */
  function qualityPrior(item) {
    const kind = item.kind === 'game' ? 'game' : item.kind === 'tv' ? 'tv' : 'movie';
    const r = item.ratings || {};
    const src = r.tmdb || r.rawg;
    if (!src || !src.votes) return 0.55;      // unrated/unreleased: flat, never computed

    const m = MT.REC.minVotes[kind];
    const C = MT.REC.priorMean[kind];
    const scale = src.scale === 5 ? 0.45 : src.scale === 100 ? 9 : 0.9;
    const R = src.score;
    const v = src.votes;
    const bayes = (v / (v + m)) * R + (m / (v + m)) * C;
    const sig = 1 / (1 + Math.exp(-(bayes - C) / scale));
    return MT.REC.qualityFloor + (1 - MT.REC.qualityFloor) * sig;
  }

  /* Bounded novelty. The obvious 1/log(vote_count) is unbounded as votes → e
     and actively fights the quality prior; this tops out at a 25% nudge. */
  function novelty(item) {
    const alpha = MT.config.get('novelty');
    const r = item.ratings || {};
    const v = (r.tmdb && r.tmdb.votes) || (r.rawg && r.rawg.votes) || 0;
    const pop = Math.log10(v + 10);
    return 1 + alpha * (1 - MT.util.clamp((pop - 2.5) / 3, 0, 1));
  }

  /* ── Candidate generation ──────────────────────────────────────────────
     Stage (a) costs ZERO requests: the recommendations and similar arrays
     arrived inside each item's detail payload via append_to_response. */
  async function gatherCandidates(profile, opts) {
    opts = opts || {};
    const all = await MT.repo.allItems();
    const owned = new Set(all.map(i => i.uid));
    const dismissed = await MT.repo.dismissedSet();
    const kind = profile.kind;

    const pool = new Map();   // uid -> { id, kind, graph: [], seeds: Set }

    const seedWeights = new Map(profile.seeds.map(s => [s.uid, s.weight]));
    const maxSeedW = Math.max(1, ...profile.seeds.map(s => s.weight));

    for (const seed of all) {
      if (seed.kind !== kind || !seed.rec || !seed.rec.candidates) continue;
      const sw = (seedWeights.get(seed.uid) || 0) / maxSeedW;
      if (sw <= 0) continue;
      for (const [bucket, q] of [['recommendations', MT.REC.graphQ.recommendations],
                                 ['similar', MT.REC.graphQ.similar]]) {
        for (const c of (seed.rec.candidates[bucket] || [])) {
          const ckind = c.kind === 'tv' ? 'tv' : c.kind === 'movie' ? 'movie' : kind;
          if (ckind !== kind) continue;
          const uid = MT.normalize.uidOf(ckind, 'tmdb', c.id);
          if (owned.has(uid) || dismissed.has(uid)) continue;
          if (!pool.has(uid)) pool.set(uid, { id: c.id, kind: ckind, graph: [], seeds: new Set() });
          pool.get(uid).graph.push({ q, seedWeight: sw, seedUid: seed.uid });
          pool.get(uid).seeds.add(seed.uid);
        }
      }
    }

    /* Stage (b): profile-driven discover. This is the only source that reflects
       the WHOLE library rather than one seed, and it is where the actual taste
       shows up. Pipe = OR is mandatory here — an AND of five keywords returns
       nothing at all. */
    if (kind !== 'game' && MT.config.hasKey('tmdb') && !opts.skipNetwork) {
      const top = topTerms(profile, 40);
      const kwIds = top.filter(t => t.term.startsWith('kw:tmdb:')).slice(0, 8)
                       .map(t => t.term.split(':')[2]);
      const castIds = top.filter(t => t.term.startsWith('p:cast:')).slice(0, 5)
                       .map(t => t.term.split(':')[2]);
      const dirIds = top.filter(t => t.term.startsWith('p:dir:')).slice(0, 4)
                       .map(t => t.term.split(':')[2]);
      const genreIds = top.filter(t => t.term.startsWith('g:tmdb:')).slice(0, 3)
                       .map(t => t.term.split(':')[2]);

      const queries = [];
      if (kwIds.length) queries.push({ with_keywords: MT.tmdb.OR(kwIds), sort_by: 'vote_average.desc' });
      if (kwIds.length) queries.push({ with_keywords: MT.tmdb.OR(kwIds), sort_by: 'popularity.desc' });
      if (castIds.length) queries.push({ with_cast: MT.tmdb.OR(castIds), sort_by: 'vote_average.desc' });
      if (dirIds.length) queries.push({ with_crew: MT.tmdb.OR(dirIds), sort_by: 'vote_average.desc' });
      if (genreIds.length && kwIds.length) {
        queries.push({ with_genres: MT.tmdb.OR(genreIds), with_keywords: MT.tmdb.OR(kwIds.slice(0, 4)),
                       sort_by: 'vote_average.desc' });
      }

      for (const q of queries.slice(0, 4)) {
        try {
          const results = await MT.tmdb.discover(kind, q, { signal: opts.signal });
          for (const r of results) {
            const uid = MT.normalize.uidOf(kind, 'tmdb', r.id);
            if (owned.has(uid) || dismissed.has(uid)) continue;
            if (!pool.has(uid)) pool.set(uid, { id: r.id, kind, graph: [], seeds: new Set() });
            pool.get(uid).raw = r;
          }
        } catch (e) {
          console.warn('[rec] discover leg failed', e && e.message);
        }
      }
    }

    return pool;
  }

  function topTerms(profile, n) {
    return Object.entries(profile.vec)
      .map(([term, v]) => ({ term, v }))
      .sort((a, b) => b.v - a.v)
      .slice(0, n);
  }

  /* ── The main entry point ──────────────────────────────────────────── */

  async function generate(kind, opts) {
    opts = opts || {};
    const profile = await buildProfile(kind);
    if (profile.empty) return { kind, empty: true, items: [], profile };

    const pool = await gatherCandidates(profile, opts);
    if (!pool.size) return { kind, empty: false, items: [], profile };

    /* Hydrate: fetch details for the most promising candidates only. Graph
       evidence is available before any fetch, so rank by that first and pay
       for detail on the top slice. */
    const ranked = [...pool.entries()]
      .map(([uid, c]) => ({ uid, c, pre: graphScore(c.graph) + (c.raw ? 0.15 : 0) }))
      .sort((a, b) => b.pre - a.pre)
      .slice(0, opts.hydrate || 60);

    const dfTable = await MT.repo.dfTable();
    const scored = [];

    for (const { uid, c } of ranked) {
      let detail = null;
      try {
        detail = await MT.net.get('tmdb',
          MT.tmdb.url(`/${c.kind}/${c.id}`, {
            append_to_response: c.kind === 'tv' ? MT.tmdb.APPEND_TV : MT.tmdb.APPEND_MOVIE,
          }),
          { ttl: MT.TTL.details, signal: opts.signal });
      } catch (e) { continue; }
      if (!detail || !detail.id) continue;

      const item = MT.normalize.fromTmdb(detail, c.kind);
      MT.repo.dfObserve(item.uid, Object.keys(item.rec.terms));   // feeds IDF

      const sim = similarity(item.rec.terms, profile.vec, dfTable);
      if (sim.score < MT.REC.minContentScore && !c.graph.length) continue;

      const gs = graphScore(c.graph);
      const base = MT.REC.contentVsGraph.content * sim.score + MT.REC.contentVsGraph.graph * gs;
      const score = base * qualityPrior(item) * novelty(item);

      scored.push({
        uid, item, score, contentScore: sim.score, graphScore: gs,
        hits: sim.hits, graphSeeds: c.graph.map(g => g.seedUid),
      });
    }

    const slate = selectDiverse(scored, opts.slate || MT.REC.slate);
    for (const s of slate) s.reason = explain(s, profile);

    await MT.repo.metaSet('rec.lastRun:' + kind, Date.now());
    return { kind, empty: false, items: slate, profile, considered: scored.length };
  }

  /* ── Diversity ─────────────────────────────────────────────────────────
     Maximal Marginal Relevance. A per-item penalty cannot work here because it
     has no idea what else ended up in the slate — diversity is a property of
     the SET, so selection has to be greedy. */
  function selectDiverse(scored, n) {
    const pool = scored.slice().sort((a, b) => b.score - a.score);
    const out = [];
    const counts = { franchise: {}, director: {}, company: {} };

    while (out.length < n && pool.length) {
      let bestIdx = -1, bestVal = -Infinity;
      for (let i = 0; i < pool.length; i++) {
        const cand = pool[i];
        if (overCap(cand, counts)) continue;
        let maxSim = 0;
        for (const chosen of out) maxSim = Math.max(maxSim, termOverlap(cand, chosen));
        const val = cand.score - MT.REC.mmrLambda * maxSim;
        if (val > bestVal) { bestVal = val; bestIdx = i; }
      }
      if (bestIdx < 0) break;
      const picked = pool.splice(bestIdx, 1)[0];
      bump(picked, counts);
      out.push(picked);
    }
    return out;
  }

  function keysFor(entry) {
    const it = entry.item;
    const dir = (it.people || []).find(p => p.role === 'director' || p.role === 'creator');
    const co = (it.companies || [])[0];
    return {
      franchise: it.rec && it.rec.franchiseKey,
      director: dir ? `p${dir.id}` : null,
      company: co ? `c${co.id}` : null,
    };
  }
  function overCap(entry, counts) {
    const k = keysFor(entry);
    for (const f of ['franchise', 'director', 'company']) {
      if (k[f] && (counts[f][k[f]] || 0) >= MT.REC.caps[f]) return true;
    }
    return false;
  }
  function bump(entry, counts) {
    const k = keysFor(entry);
    for (const f of ['franchise', 'director', 'company']) {
      if (k[f]) counts[f][k[f]] = (counts[f][k[f]] || 0) + 1;
    }
  }
  function termOverlap(a, b) {
    const ta = a.item.rec.terms, tb = b.item.rec.terms;
    let shared = 0, total = 0;
    for (const t of Object.keys(ta)) { total++; if (tb[t]) shared++; }
    return total ? shared / total : 0;
  }

  /* ── Reasons ───────────────────────────────────────────────────────────
     Re-attribution of the actual dot product through the contribution map, not
     a post-hoc guess. A graph-only candidate is worded DIFFERENTLY on purpose:
     claiming a content match that didn't drive the score is a small lie users
     detect quickly, and it poisons trust in every other reason on the page. */
  function explain(entry, profile) {
    const seedScores = {};
    for (const [term, weight] of Object.entries(entry.hits || {})) {
      const perSeed = profile.contrib[term];
      if (!perSeed) continue;
      for (const [uid, amount] of Object.entries(perSeed)) {
        seedScores[uid] = (seedScores[uid] || 0) + weight * amount;
      }
    }
    const total = Object.values(seedScores).reduce((a, b) => a + b, 0);
    const seedList = Object.entries(seedScores)
      .filter(([, v]) => total > 0 && v / total >= 0.08)
      .sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([uid]) => (profile.seeds.find(s => s.uid === uid) || {}).title)
      .filter(Boolean);

    const termList = Object.entries(entry.hits || {})
      .sort((a, b) => b[1] - a[1]).slice(0, 3)
      .map(([term]) => labelForTerm(term, entry.item))
      .filter(Boolean);

    if (entry.contentScore < 0.05 && entry.graphScore > 0.1) {
      const via = entry.graphSeeds.map(uid => (profile.seeds.find(s => s.uid === uid) || {}).title)
        .filter(Boolean).slice(0, 2);
      return { kind: 'graph', text: via.length
        ? `Viewers of <b>${MT.util.escapeHtml(via.join('</b> and <b>'))}</b> also watched this`
        : 'Frequently watched alongside things in your library' };
    }
    if (seedList.length && termList.length) {
      return { kind: 'both', text:
        `Because you liked <b>${MT.util.escapeHtml(seedList.join('</b>, <b>'))}</b> — shares ${termList.map(t => `<b>${MT.util.escapeHtml(t)}</b>`).join(', ')}` };
    }
    if (seedList.length) {
      return { kind: 'seeds', text: `Because you liked <b>${MT.util.escapeHtml(seedList.join('</b>, <b>'))}</b>` };
    }
    if (termList.length) {
      return { kind: 'terms', text: `Matches your interest in ${termList.map(t => `<b>${MT.util.escapeHtml(t)}</b>`).join(', ')}` };
    }
    return { kind: 'fallback', text: 'Highly rated in genres you watch a lot' };
  }

  function labelForTerm(term, item) {
    if (term.startsWith('kw:')) {
      const id = term.split(':')[2];
      const k = (item.keywords || []).find(x => String(x.id) === id);
      return k && k.name;
    }
    if (term.startsWith('g:')) {
      const id = term.split(':')[2];
      const g = (item.genres || []).find(x => String(x.id) === id);
      return g && g.name;
    }
    if (term.startsWith('p:')) {
      const id = term.split(':').pop();
      const p = (item.people || []).find(x => String(x.id) === id);
      return p && p.name;
    }
    if (term.startsWith('co:')) {
      const id = term.split(':').pop();
      const c = (item.companies || []).find(x => String(x.id).endsWith(id));
      return c && c.name;
    }
    if (term.startsWith('tag:')) return term.split(':').pop();
    return null;
  }

  /* "More like this" on an item page — ZERO network requests.

     The candidate summaries were captured when this item's details were
     fetched, so everything needed to draw a card is already on the record.
     Fetching full details for each one just to render a poster cost a dozen
     requests per item page and bought nothing the user could see.

     Ranking uses genre overlap against the taste profile, which is weaker than
     the keyword-level scoring on #/recs but is free. The deep profile scoring
     stays where its cost is amortised. */
  async function moreLikeThis(item, opts) {
    opts = opts || {};
    const owned = new Set((await MT.repo.allItems()).map(i => i.uid));
    const dismissed = await MT.repo.dismissedSet();
    const profile = await buildProfile(item.kind);

    /* Genre affinity from the profile, keyed by raw TMDB genre id — the only
       signal present in a candidate summary. */
    const genreWeight = {};
    for (const [term, v] of Object.entries(profile.vec || {})) {
      if (term.startsWith('g:tmdb:')) genreWeight[term.split(':')[2]] = v;
    }

    const cands = []
      .concat((item.rec.candidates.recommendations || []).map(c => ({ ...c, src: 'recommendations' })))
      .concat((item.rec.candidates.similar || []).map(c => ({ ...c, src: 'similar' })));

    const seen = new Set();
    const out = [];
    for (const c of cands) {
      if (!c || !c.id) continue;
      const uid = MT.normalize.uidOf(c.kind, 'tmdb', c.id);
      if (owned.has(uid) || dismissed.has(uid) || seen.has(uid)) continue;
      seen.add(uid);

      const stub = MT.normalize.candidateToStub(c);
      const affinity = (c.genreIds || []).reduce((s, g) => s + (genreWeight[g] || 0), 0);
      /* TMDB's own ordering is meaningful, so position is kept as a prior and
         the taste signal nudges rather than replaces it. */
      const positional = 1 / (1 + out.length * 0.05);
      const srcWeight = c.src === 'recommendations' ? 1 : 0.85;
      out.push({ uid, item: stub, score: (0.6 + affinity) * positional * srcWeight * qualityPrior(stub) });
    }
    out.sort((a, b) => b.score - a.score);
    return out.slice(0, opts.limit || 12);
  }

  /* ── Shared slate cache ────────────────────────────────────────────────
     Home and #/recs render the same slate from one cache. Regenerating on
     every home visit cost ~39 requests, and it was only ever "free" on a
     revisit because the individual URL responses happened to still be cached.

     The cache is keyed on a fingerprint of the library, so adding or rating
     something invalidates it — the slate refreshes when your taste actually
     changed, not on a timer. */
  async function libraryFingerprint(kind) {
    const all = await MT.repo.allItems();
    const rel = all.filter(i => i.kind === kind && i.user && i.user.status !== 'dropped');
    let h = `${rel.length}|${MT.config.get('novelty')}`;
    for (const i of rel) h += `${i.uid}:${i.user.status}:${i.user.rating || ''};`;
    return MT.util.fnv1a(h);
  }

  async function cachedSlate(kind, opts) {
    opts = opts || {};
    const key = 'rec.slate:' + kind;
    const fp = await libraryFingerprint(kind);
    if (!opts.force) {
      const hit = await MT.repo.metaGet(key);
      if (hit && hit.fp === fp && Date.now() - hit.at < MT.TTL.recSlate) {
        return { items: hit.items, profileTerms: hit.profileTerms, cached: true };
      }
    }
    const res = await generate(kind, opts);
    if (res.empty) return { items: [], empty: true, profileTerms: [] };

    /* Store a trimmed copy — the full normalized items would be megabytes. */
    const slim = res.items.map(r => ({
      uid: r.uid, reason: r.reason, score: r.score,
      item: {
        uid: r.item.uid, kind: r.item.kind, title: r.item.title,
        facets: r.item.facets, images: r.item.images, release: r.item.release,
        ratings: { tmdb: r.item.ratings.tmdb },
      },
    }));
    const profileTerms = topTerms(res.profile, 12).map(t => t.term);
    await MT.repo.metaSet(key, { at: Date.now(), fp, items: slim, profileTerms });
    return { items: slim, profileTerms, cached: false };
  }

  return {
    buildProfile, generate, cachedSlate, libraryFingerprint, moreLikeThis,
    similarity, qualityPrior, novelty,
    topTerms, idfOf, seedWeight, explain, selectDiverse, normalizeByFacet,
  };
})();
