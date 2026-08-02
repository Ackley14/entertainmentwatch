/* ══════════════════════════════════════════════════════════════════════════
   Network layer — the ONLY place in the app that calls fetch().

   Everything upstream goes through `MT.net.get()`, which gives us one place to
   put the rate limiter, the response cache, retries, the request budget and —
   most importantly — the error classifier. That last one matters more than it
   sounds: RAWG's 401/403/429 responses come from Cloudflare with no CORS
   header at all, so the browser rejects them as an opaque `TypeError` before
   any status code is readable. Offline and "your key is dead" are literally
   the same exception. Untangling that is `diagnose()`.
   ══════════════════════════════════════════════════════════════════════════ */

MT.net = (function () {

  /* ── Token bucket ────────────────────────────────────────────────────── */
  class Bucket {
    constructor(rps) { this.rps = rps; this.tokens = rps; this.last = Date.now(); }
    async take() {
      for (;;) {
        const now = Date.now();
        this.tokens = Math.min(this.rps, this.tokens + ((now - this.last) / 1000) * this.rps);
        this.last = now;
        if (this.tokens >= 1) { this.tokens -= 1; return; }
        await MT.util.sleep(Math.max(20, ((1 - this.tokens) / this.rps) * 1000));
      }
    }
  }

  /* ── Concurrency lane ─────────────────────────────────────────────────── */
  class Lane {
    constructor(max) { this.max = max; this.active = 0; this.queue = []; }
    acquire() {
      if (this.active < this.max) { this.active++; return Promise.resolve(); }
      return new Promise(res => this.queue.push(res));
    }
    release() {
      const next = this.queue.shift();
      if (next) next();            // hand the slot straight on, count unchanged
      else this.active = Math.max(0, this.active - 1);
    }
  }

  const buckets = {}, lanes = {}, circuits = {};
  for (const [src, p] of Object.entries(MT.NET_POLICY)) {
    buckets[src] = new Bucket(p.rps);
    lanes[src] = new Lane(p.concurrency);
    circuits[src] = { fails: 0, openUntil: 0 };
  }

  /* ── Request budgets ──────────────────────────────────────────────────
     These are SELF-THROTTLES, not a view of the real quota. RAWG and OMDb
     count per key, and a key baked into a public repo is shared with everyone
     who forks it — this counter can only ever see requests from this browser.
     The UI must say "requests from this browser", never "remaining quota". */
  const budgetCache = {};

  async function budgetKey(source) {
    const p = MT.NET_POLICY[source];
    if (p.monthlyBudget) return { key: `req:${source}:${MT.util.monthStamp()}`, cap: p.monthlyBudget };
    if (p.dailyBudget)   return { key: `req:${source}:${MT.util.todayStamp()}`, cap: p.dailyBudget };
    return null;
  }

  async function budgetTake(source) {
    const b = await budgetKey(source);
    if (!b) return true;
    if (budgetCache[b.key] == null) {
      budgetCache[b.key] = (await MT.repo.metaGet(b.key)) || 0;
    }
    if (budgetCache[b.key] >= b.cap) return false;
    budgetCache[b.key]++;
    MT.repo.metaSet(b.key, budgetCache[b.key]);      // fire and forget
    return true;
  }

  /* Refund a unit consumed by a request that never reached the network — a
     circuit-open short-circuit, an abort, a cache race. Without this the
     budget drifts down every time the app has a bad day. */
  async function budgetRefund(source) {
    const b = await budgetKey(source);
    if (!b || budgetCache[b.key] == null) return;
    budgetCache[b.key] = Math.max(0, budgetCache[b.key] - 1);
    MT.repo.metaSet(b.key, budgetCache[b.key]);
  }

  async function budgetState(source) {
    const b = await budgetKey(source);
    if (!b) return null;
    if (budgetCache[b.key] == null) budgetCache[b.key] = (await MT.repo.metaGet(b.key)) || 0;
    return { used: budgetCache[b.key], cap: b.cap, period: MT.NET_POLICY[source].monthlyBudget ? 'month' : 'day' };
  }

  /* ── Errors ───────────────────────────────────────────────────────────── */
  class NetError extends Error {
    constructor(kind, message, opts) {
      super(message);
      this.name = 'NetError';
      this.kind = kind;            // offline | auth | quota | notfound | server | opaque | budget | abort | parse
      Object.assign(this, opts || {});
    }
    get retryable() { return this.kind === 'server' || this.kind === 'quota-soft'; }
  }

  /* Does the machine believe it has a network at all? navigator.onLine is
     famously optimistic, so a TMDB probe is the real test — TMDB is CORS-clean
     from every origin including file://, which makes it a reliable control. */
  let lastProbe = { at: 0, ok: null };
  async function probeInternet() {
    if (Date.now() - lastProbe.at < 15000) return lastProbe.ok;
    let ok = false;
    try {
      const r = await fetch('https://api.themoviedb.org/3/configuration?api_key=probe', {
        method: 'GET', cache: 'no-store',
      });
      ok = !!r;                    // even a 401 proves we reached the internet
    } catch (_) { ok = false; }
    lastProbe = { at: Date.now(), ok };
    return ok;
  }

  /* Turn an opaque failure into something a human can act on. Always async —
     uniformly, for every source — because a classifier that returns a Promise
     for some sources and a value for others produces the subtlest possible
     bug: `!err.retryable` on a Promise is always false. */
  async function classify(source, err, res) {
    if (err && err.name === 'AbortError') return new NetError('abort', 'Request cancelled');

    if (res) {
      const s = res.status;
      if (s === 401 || s === 403) return new NetError('auth', `${source}: key rejected`, { status: s });
      if (s === 404) return new NetError('notfound', `${source}: not found`, { status: s });
      if (s === 429) {
        const ra = parseInt(res.headers.get('retry-after') || '0', 10);
        return new NetError('quota-soft', `${source}: rate limited`, { status: s, retryAfter: ra });
      }
      if (s >= 500) return new NetError('server', `${source}: upstream error ${s}`, { status: s });
      return new NetError('server', `${source}: HTTP ${s}`, { status: s });
    }

    /* No response object at all — the browser refused before we could read it. */
    const online = await probeInternet();
    if (!online) return new NetError('offline', 'You appear to be offline.');

    if (source === 'rawg') {
      const hasKey = MT.config.hasKey('rawg');
      const b = await budgetState('rawg');
      const spent = b && b.used >= b.cap;
      return new NetError('opaque',
        !hasKey ? 'No RAWG key is set, so game data is unavailable.'
        : spent ? 'This browser has hit its RAWG request budget for the month.'
        : 'Could not reach RAWG. That usually means the key is missing, wrong, or out of monthly quota — the browser cannot tell us which, because RAWG sends errors without CORS headers.',
        { source, actionable: true });
    }
    return new NetError('opaque', `Could not reach ${source}.`, { source });
  }

  /* ── Circuit breaker ─────────────────────────────────────────────────── */
  function circuitOpen(source) { return Date.now() < circuits[source].openUntil; }
  function circuitTrip(source) {
    const c = circuits[source];
    if (++c.fails >= 4) {
      c.openUntil = Date.now() + 60000;
      c.fails = 0;
      console.warn(`[net] circuit open for ${source} (60s)`);
    }
  }
  function circuitReset(source) { circuits[source].fails = 0; circuits[source].openUntil = 0; }

  /* ── Cache key ────────────────────────────────────────────────────────
     Credentials are stripped before hashing, so no key is ever written to
     IndexedDB and rotating a key doesn't invalidate the whole cache. */
  function cacheKeyFor(url) {
    try {
      const u = new URL(url);
      u.searchParams.delete('api_key');
      u.searchParams.delete('key');
      u.searchParams.delete('apikey');
      u.searchParams.sort();
      return u.origin + u.pathname + '?' + u.searchParams.toString();
    } catch (_) { return url; }
  }

  /* ══ The one request path ══════════════════════════════════════════════ */
  async function get(source, url, opts) {
    opts = opts || {};
    const policy = MT.NET_POLICY[source] || MT.NET_POLICY.tmdb;
    const ck = cacheKeyFor(url);
    const ttl = opts.ttl != null ? opts.ttl : MT.TTL.details;

    /* 1. Cache first. */
    if (!opts.noCache) {
      const hit = await MT.repo.cacheGet(ck);
      if (hit && !hit.stale) return hit.payload;
      if (hit && opts.staleOk !== false) opts._stale = hit;   // keep as a fallback
    }
    if (opts.cacheOnly) return opts._stale ? opts._stale.payload : null;

    /* 2. Circuit + budget gates, both of which must refund cleanly. */
    if (circuitOpen(source)) {
      if (opts._stale) return opts._stale.payload;
      throw new NetError('server', `${source} is temporarily unavailable.`, { source });
    }
    if (!(await budgetTake(source))) {
      if (opts._stale) return opts._stale.payload;
      throw new NetError('budget',
        `This browser has used its ${source.toUpperCase()} request budget for the ${policy.monthlyBudget ? 'month' : 'day'}.`,
        { source });
    }

    let spent = true;                          // a budget unit is outstanding
    await lanes[source].acquire();             // acquired ONCE...
    try {
      let lastErr = null;
      for (let attempt = 0; attempt <= policy.retries; attempt++) {
        await buckets[source].take();
        let res = null;
        try {
          res = await fetch(url, {
            method: opts.method || 'GET',
            headers: opts.headers || undefined,
            body: opts.body || undefined,
            signal: opts.signal,
            cache: 'no-cache',                 /* revalidate via ETag; do NOT
                                                  cache-bust with ?v=Date.now(),
                                                  which defeats 304s entirely */
            credentials: 'omit',               /* wildcard ACAO forbids credentials */
          });
        } catch (rawErr) {
          lastErr = await classify(source, rawErr, null);
          if (lastErr.kind === 'abort') throw lastErr;
          break;                               // opaque/offline: retrying won't help
        }

        if (res.ok) {
          circuitReset(source);
          let payload;
          try { payload = await res.json(); }
          catch (e) { throw new NetError('parse', `${source}: malformed response`); }
          /* AniList answers 429 with HTTP 200 and an `errors` array, so a naive
             res.ok check would treat a rate-limit as success. */
          if (payload && payload.errors && !payload.data) {
            lastErr = new NetError('server', payload.errors[0]?.message || `${source}: API error`);
            if (attempt < policy.retries) { await backoff(attempt, 0); continue; }
            break;
          }
          if (!opts.noCache && ttl > 0) {
            MT.repo.cachePut(ck, source, payload, ttl, opts.cacheClass || 'reduced');
          }
          return payload;
        }

        lastErr = await classify(source, null, res);
        if (!lastErr.retryable || attempt === policy.retries) break;
        await backoff(attempt, lastErr.retryAfter);
      }

      if (lastErr && (lastErr.kind === 'server' || lastErr.kind === 'opaque')) circuitTrip(source);
      /* Nothing reached the network usefully — give the unit back. */
      if (lastErr && (lastErr.kind === 'offline' || lastErr.kind === 'opaque')) {
        await budgetRefund(source); spent = false;
      }
      if (opts._stale) {
        console.warn(`[net] serving stale ${source} for ${ck}:`, lastErr && lastErr.message);
        return opts._stale.payload;
      }
      throw lastErr || new NetError('server', `${source}: request failed`);
    } finally {
      lanes[source].release();                 /* ...and released ONCE. Putting
                                                  this inside the retry loop
                                                  leaks a slot per retry until
                                                  the limiter stops existing. */
      void spent;
    }
  }

  /* Full-jitter exponential backoff; an explicit Retry-After always wins. */
  async function backoff(attempt, retryAfterSec) {
    if (retryAfterSec > 0) return MT.util.sleep(Math.min(retryAfterSec * 1000, 15000));
    const ceiling = Math.min(8000, 350 * Math.pow(2, attempt));
    return MT.util.sleep(Math.random() * ceiling);
  }

  async function post(source, url, body, opts) {
    return get(source, url, Object.assign({}, opts, {
      method: 'POST',
      body: typeof body === 'string' ? body : JSON.stringify(body),
      headers: Object.assign({ 'Content-Type': 'application/json', 'Accept': 'application/json' },
                             (opts && opts.headers) || {}),
    }));
  }

  function qs(params) {
    const parts = [];
    for (const [k, v] of Object.entries(params)) {
      if (v === undefined || v === null || v === '') continue;
      parts.push(encodeURIComponent(k) + '=' + encodeURIComponent(v));
    }
    return parts.join('&');
  }

  return {
    get, post, qs, NetError, budgetState, probeInternet, cacheKeyFor,
    _lanes: lanes,      // exposed for the concurrency-leak test
    _buckets: buckets,
  };
})();
