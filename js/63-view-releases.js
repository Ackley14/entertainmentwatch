/* ══════════════════════════════════════════════════════════════════════════
   #/releases — what is coming out, whether or not you are tracking it.

   NOT to be confused with #/up "Coming Up", which plots the release dates of
   titles already in your index. This is the opposite: discovery. Nothing here
   is yours yet, and every row carries an Add button.

   Five rules shape the whole view.

   1 · "Anything with a fixed known date." A window query returns plenty of
       titles whose date is a Jan-1 placeholder meaning "sometime in 2027";
       derivePrecision demotes those to year precision. Showing them under a
       heading that promises a date would be a lie the user acts on, so only
       precision === 'day' survives. What was dropped is disclosed, not hidden.

   2 · Obscurity is judged RELATIVE to the window, never against a fixed number.
       Measured against the live API: an unfiltered week returns 319 films, this
       week's most popular scores 15.3, next month's 46.8, and a year out the
       entire top five sits between 1.6 and 2.0 — and that five is Turtles,
       Bluey and Narnia. A fixed floor either floods this week or empties next
       year. So the scale is the MEDIAN notability of the window's own first
       page, and the slider is a multiplier on it. Median rather than maximum,
       because one runaway hit (next month's 46.8 against a 10.5 runner-up)
       would otherwise drag the floor over genuinely notable films.

   3 · The slider is a DISPLAY filter, not a fetch filter. Rows are accumulated
       down to a fixed noise floor and hidden above it, so dragging it is
       instant and never costs a request. Only paging termination consults the
       current floor — and lowering the slider clears `done`, so scrolling can
       pull the extra pages that the wider setting now wants.

   4 · Order is date ascending, then notability descending inside a day. The
       score itself is never shown; it just decides who leads the day.

   5 · One request per page, one page in flight, nothing until the route opens.
       Boot still costs zero.
   ══════════════════════════════════════════════════════════════════════════ */

MT.viewReleases = (function () {
  const esc = MT.util.escapeHtml;

  const KINDS = [
    { id: 'movie', label: 'Film' },
    { id: 'tv',    label: 'TV' },
    { id: 'game',  label: 'Games' },
    { id: 'anime', label: 'Anime' },
  ];

  /* RAWG allows 20,000 requests a month against a view that could otherwise
     page forever. Only games are capped, and it says so rather than looking
     like the end of the catalogue. */
  const RAWG_MAX_PAGES = 10;

  /* Below this a record is a title and nothing else, and it is never kept.
     The two sources are on different scales and need different answers:

     · TMDB `popularity` is a continuous score that never reaches 0 for a real
       entry — page 10 of an unfiltered week still scores 0.34.
     · RAWG `added` is an integer count of users holding the game. A genuinely
       new listing sits at 0 precisely BECAUSE it is upcoming, so a floor here
       would hide exactly what this view exists to show. Games rely on the
       median instead, and "everything" really does mean everything. */
  const NOISE_FLOOR = { tmdb: 0.3, rawg: 0 };
  const noiseFor = kind => (kind === 'game' ? NOISE_FLOOR.rawg : NOISE_FLOOR.tmdb);

  const SLIDER_KEY = 'mt.releases.notability';
  const DEFAULT_POS = 50;

  /* Slider position (0-100) to a multiple of the window's median.

       0   → 0     every title above the noise floor
       50  → 1.0   the median cut, which is the useful default
       100 → 3.5   only the standout

     Piecewise so that the midpoint lands exactly on 1.0. A straight 0..3.5
     ramp would put the median cut at position 29, which is a strange place to
     find the setting most people want. */
  function multiplierFor(pos) {
    const t = MT.util.clamp(pos, 0, 100) / 100;
    return t <= 0.5 ? t * 2 : 1 + (t - 0.5) * 5;
  }

  const state = new Map();
  let day = MT.util.todaySortKey();

  let observer = null;
  let token = 0;
  let touchStart = null;
  let moved = false;
  let filterText = '';
  let sliderPos = readSlider();

  function readSlider() {
    try {
      const v = parseInt(localStorage.getItem(SLIDER_KEY), 10);
      return Number.isFinite(v) ? MT.util.clamp(v, 0, 100) : DEFAULT_POS;
    } catch (_) { return DEFAULT_POS; }
  }
  function writeSlider(v) {
    try { localStorage.setItem(SLIDER_KEY, String(v)); } catch (_) {}
  }

  function keyOf(kind, range, custom) {
    /* A custom window is a different query for every pair of dates, so the
       endpoints belong in the key — otherwise two different stretches of
       calendar would share one accumulated list. */
    return range === 'custom'
      ? `${kind}|custom|${(custom && custom.from) || ''}|${(custom && custom.to) || ''}`
      : `${kind}|${range}`;
  }

  function freshState(kind) {
    return {
      noise: noiseFor(kind),
      rows: [], seen: new Set(), dropped: 0,
      page: 0, totalPages: null, total: 0,
      done: false, loading: false, capped: false,
      scale: null,        // median notability of page 1, set once
      belowNoise: 0,      // never kept at all
      stale: null,        // { fetchedAt, reason } when served from cache
      wd: null,           // { count, only } once the supplement has run
      titles: new Set(),  // normalised title|year, for cross-source dedup
    };
  }

  /* The live floor for the current slider position. */
  function floorOf(st) {
    const k = multiplierFor(sliderPos);
    if (!k) return st.noise;
    return Math.max(st.noise, (st.scale || 0) * k);
  }

  async function render(params, query) {
    const view = document.getElementById('view');
    const q = query || {};
    const kind = KINDS.some(k => k.id === q.kind) ? q.kind : 'movie';
    const range = MT.util.RELEASE_RANGES.some(r => r.id === q.range) ? q.range : 'month';
    const custom = { from: q.from || '', to: q.to || '' };

    /* Leaving the route must stop the scroll watcher, or it keeps firing
       against a list that is no longer on screen. */
    if (observer) { observer.disconnect(); observer = null; }
    token++;
    filterText = '';

    MT.ui.crumb(['Discover', 'Releases']);
    MT.ui.paneActions('');

    if (day !== MT.util.todaySortKey()) { state.clear(); day = MT.util.todaySortKey(); }

    const win = MT.util.releaseWindow(range, custom);
    view.innerHTML = `
      <div class="toolbar">
        <div class="chips" id="relKinds">
          ${KINDS.map(k => `<button class="chip" type="button" data-kind="${k.id}"
            aria-pressed="${k.id === kind}">${k.label}</button>`).join('')}
        </div>
      </div>
      <div class="toolbar toolbar--sub">
        <div class="chips" id="relRanges">
          ${MT.util.RELEASE_RANGES.map(r => `<button class="chip" type="button" data-range="${r.id}"
            aria-pressed="${r.id === range}">${esc(r.label)}</button>`).join('')}
        </div>
      </div>
      ${range === 'custom' ? `
      <div class="relbar relbar--dates">
        <label for="relFrom">From</label>
        <input type="date" id="relFrom" value="${esc(custom.from || MT.util.skToISO(win.from))}">
        <label for="relTo">to</label>
        <input type="date" id="relTo" value="${esc(custom.to || MT.util.skToISO(win.to))}">
      </div>` : ''}
      <div class="relbar">
        <input type="search" id="relFilter" class="sfield" autocomplete="off"
               placeholder="Filter what is loaded…" aria-label="Filter loaded releases">
        <span class="relwin mono faint">${esc(MT.util.skToISO(win.from))} → ${esc(MT.util.skToISO(win.to))}</span>
      </div>
      <div class="notabar">
        <label for="relNota">Notability</label>
        <span class="notaend faint">everything</span>
        <input type="range" id="relNota" min="0" max="100" step="5" value="${sliderPos}"
               aria-label="How obscure a release has to be before it is hidden">
        <span class="notaend faint">only the biggest</span>
      </div>
      <div id="relBody">
        <div id="relList"></div>
        <div id="relSentinel" aria-hidden="true"></div>
        <div id="relFoot"></div>
      </div>`;

    wire(view, kind, range, win, custom);

    const key = keyOf(kind, range, custom);
    if (!state.has(key)) state.set(key, freshState(kind));
    const st = state.get(key);

    if (st.rows.length) {
      rebuild(st);
      foot(st);
      watch(st, kind, range, win);
    } else {
      document.getElementById('relList').innerHTML = skeletonRows();
      loadPage(st, kind, range, win).then(() => watch(st, kind, range, win));
    }
  }

  function wire(view, kind, range, win, custom) {
    const go = patch => {
      const n = Object.assign({ kind, range, from: custom.from, to: custom.to }, patch);
      let hash = `#/releases?kind=${n.kind}&range=${n.range}`;
      if (n.range === 'custom') {
        /* Seed an empty custom range with the window currently on screen, so
           picking "Custom" shows something rather than an empty form. */
        hash += `&from=${encodeURIComponent(n.from || MT.util.skToISO(win.from))}`;
        hash += `&to=${encodeURIComponent(n.to || MT.util.skToISO(win.to))}`;
      }
      MT.router.go(hash);
    };

    /* Assignment, not addEventListener — #view outlives the route. */
    view.onclick = async e => {
      const k = e.target.closest('[data-kind]');
      if (k) return go({ kind: k.dataset.kind });
      const r = e.target.closest('[data-range]');
      if (r) return go({ range: r.dataset.range });

      const more = e.target.closest('[data-more]');
      if (more) {
        const st = state.get(keyOf(kind, range, custom));
        if (st && !st.loading && !st.done) await loadPage(st, kind, range, win);
        return;
      }

      const addBtn = e.target.closest('[data-add]');
      if (addBtn) {
        if (suppressTap()) return;
        const st = state.get(keyOf(kind, range, custom));
        const hit = st && st.rows.find(x => x.stub.uid === addBtn.dataset.add);
        if (!hit || hit.owned) return;
        await MT.ui.addItem(hit.stub);
        hit.owned = 'want';
        addBtn.outerHTML = '<span class="add is-in">✓ Want</span>';
        return;
      }

      const el = e.target.closest('[data-uid]');
      if (!el || suppressTap()) return;
      MT.inspector.show(el.dataset.uid);
    };

    /* The slider only ever re-filters what is already loaded, so it responds
       on `input` — every drag position, no request, no wait. */
    const from = document.getElementById('relFrom');
    const to = document.getElementById('relTo');
    const applyDates = () => {
      if (!from || !to) return;
      const a = MT.util.isoToSortKey(from.value);
      const b2 = MT.util.isoToSortKey(to.value);
      if (!a || !b2) return;                 // half-typed date: wait
      if (b2 < a) { to.value = from.value; return; }
      go({ range: 'custom', from: from.value, to: to.value });
    };
    if (from) from.onchange = applyDates;
    if (to) to.onchange = applyDates;

    const nota = document.getElementById('relNota');
    if (nota) {
      /* Widening the cut can want pages we stopped fetching. Clearing `done`
         is not enough on its own: the observer fires on intersection CHANGES,
         and the sentinel is usually already visible at that moment, so nothing
         would load until the user happened to scroll. Kick it directly —
         debounced, because a drag emits an event per step. */
      const resume = MT.util.debounce(() => {
        const st = state.get(keyOf(kind, range, custom));
        if (st && !st.done && !st.loading) loadPage(st, kind, range, win);
      }, 200);

      nota.oninput = () => {
        const prev = sliderPos;
        sliderPos = +nota.value;
        writeSlider(sliderPos);
        const st = state.get(keyOf(kind, range, custom));
        if (!st) return;
        if (sliderPos < prev && !st.capped
            && (st.totalPages == null || st.page < st.totalPages)) {
          st.done = false;
        }
        rebuild(st);
        foot(st);
        if (!st.done) resume();
      };
    }

    /* Filtering rebuilds only the list. The input lives outside it and is
       never touched, so the caret cannot be moved out from under a typist. */
    const f = document.getElementById('relFilter');
    if (f) {
      f.oninput = MT.util.debounce(() => {
        filterText = f.value.trim().toLowerCase();
        const st = state.get(keyOf(kind, range, custom));
        if (!st) return;
        rebuild(st);
        foot(st);
      }, 140);
    }

    view.ontouchstart = e => {
      const t = e.touches[0];
      touchStart = { x: t.clientX, y: t.clientY };
      moved = false;
    };
    view.ontouchmove = e => {
      if (!touchStart) return;
      const t = e.touches[0];
      if (Math.abs(t.clientY - touchStart.y) > 8 || Math.abs(t.clientX - touchStart.x) > 8) moved = true;
    };
  }

  /* A tap that followed finger movement is a scroll. */
  function suppressTap() {
    const was = moved;
    moved = false;
    return was;
  }

  /* ── Loading ──────────────────────────────────────────────────────────── */

  async function loadPage(st, kind, range, win) {
    if (st.loading || st.done) return;
    const mine = token;
    st.loading = true;
    foot(st);

    const next = st.page + 1;
    const meta = {};
    let env;
    try {
      env = await fetchPage(kind, win, next, meta);
    } catch (e) {
      if (mine !== token) return;
      st.loading = false;

      /* Games have a second source. Before reporting failure, ask Wikidata —
         a list of well-known releases beats an error message. */
      if (kind === 'game' && next === 1 && !st.wd) {
        const l0 = document.getElementById('relList');
        if (l0) l0.innerHTML = '';
        await supplement(st, win, mine);
        if (mine !== token) return;
        if (st.wd && st.wd.count) {
          st.page = 1;
          st.done = true;                    // no paging without the primary
          rebuild(st);
          foot(st);
          return;
        }
      }

      st.error = e;
      /* Clear the skeletons. Leaving shimmering placeholders above an error
         message reads as "still working on it" when it is not. */
      if (!st.rows.length) {
        const l = document.getElementById('relList');
        if (l) l.innerHTML = '';
      }
      foot(st);
      return;
    }
    if (mine !== token) { st.loading = false; return; }

    /* The scale is set once, from the first page, and never moves. If it
       drifted as pages loaded, rows already on screen would start and stop
       qualifying while the user watched. */
    if (st.scale == null) st.scale = medianNotability(env.results, kind);

    const added = await absorb(st, env.results, kind, win);

    st.page = next;
    st.total = env.total || st.total;
    st.totalPages = env.totalPages;
    st.loading = false;
    st.error = null;
    /* Remember the OLDEST stale answer: if any page came from cache, the list
       as a whole is only as current as that. */
    if (meta.stale && (!st.stale || meta.fetchedAt < st.stale.fetchedAt)) {
      st.stale = { fetchedAt: meta.fetchedAt, reason: meta.reason };
    }

    /* Results arrive in notability order, so once a page ends below the
       current floor every later page does too. This is what stops paging
       without walking the whole catalogue — and it is re-evaluated whenever
       the slider widens. */
    if (env.results.length) {
      const last = notabilityOf(env.results[env.results.length - 1], kind);
      if (last < floorOf(st)) st.done = true;
    }
    if (kind === 'game' && next >= RAWG_MAX_PAGES) { st.capped = true; st.done = true; }
    if (env.totalPages != null && next >= env.totalPages) st.done = true;
    if (!env.results.length) st.done = true;

    if (st.page === 1) document.getElementById('relList').innerHTML = '';

    /* Games get a second opinion. RAWG is the only source that can enumerate
       the long tail, so it stays primary — but it goes down often, and when it
       does the whole games tab would otherwise be empty. Wikidata holds far
       fewer upcoming titles (~295 across a year against Steam's thousands) and
       they are the well-known ones, which is exactly the right shape for a
       floor: you lose the obscure end, never the whole view.

       Runs once per window, after the first RAWG page, so it costs one extra
       request and only on the games tab. */
    if (kind === 'game' && next === 1 && !st.wd) {
      await supplement(st, win, mine);
    }

    if (added.length || (st.wd && st.wd.count)) rebuild(st);
    foot(st);

    /* A page can be entirely placeholders or all below the noise floor, which
       would leave the list looking finished while more exists. */
    if (!added.length && !st.done) await loadPage(st, kind, range, win);
  }

  /* Titles Wikidata knows about that RAWG did not return — either because
     RAWG is down, or simply because the two catalogues disagree. */
  async function supplement(st, win, mine) {
    const meta = {};
    let rows;
    try {
      rows = await MT.wikidata.releasesBetween(
        MT.util.skToISO(win.from), MT.util.skToISO(win.to), { limit: 120, meta });
    } catch (e) {
      /* A failed supplement is not a failed view. If RAWG answered, the user
         still has a list; if it did not, its own error is the one to show. */
      console.warn('[releases] wikidata supplement unavailable', e && e.message);
      st.wd = { count: 0, only: !st.rows.length, failed: true };
      return;
    }
    if (mine !== token) return;

    const owned = new Map();
    for (const it of await MT.repo.allItems()) owned.set(it.uid, it.user.status);

    let n = 0;
    const scores = [];
    for (const r of rows) {
      const stub = MT.normalize.stubFromWikidata(r);
      if (!stub) continue;
      if (stub.release.precision !== 'day') { st.dropped++; continue; }
      const sk = stub.release.sortKey;
      if (sk < win.from || sk > win.to) { st.dropped++; continue; }
      if (st.seen.has(stub.uid)) continue;
      /* Cross-source dedup. The uids differ by construction (game:rawg:3498 vs
         game:wikidata:Q123), so identity has to come from the content: a Steam
         appid where both sides have one, and normalised title plus year
         otherwise. */
      const key = titleKey(stub);
      if (st.titles.has(key)) continue;
      if (stub.ids.steam && st.steam && st.steam.has(String(stub.ids.steam))) continue;

      st.seen.add(stub.uid);
      st.titles.add(key);
      /* Sitelinks and RAWG `added` are different scales entirely, so the raw
         number cannot go in the same field. Rescaled onto whatever RAWG's
         median for this window turned out to be, so one slider governs both.
         With no RAWG data at all the median is 0 and everything is visible,
         which is the correct behaviour when it is the only source present. */
      const score = (st.scale || 0) > 0
        ? (r.sitelinks / WD_MEDIAN_SITELINKS) * st.scale
        : r.sitelinks;
      st.rows.push({ stub, score, owned: owned.get(stub.uid) || null, source: 'wikidata' });
      scores.push(score);
      n++;
    }

    /* With RAWG down there was never a page 1 to take a median from, so the
       floor stayed at zero and the slider did nothing. Fall back to Wikidata's
       own median so the control still works when it is the only source — the
       scores in that case ARE raw sitelink counts, so the two agree. */
    if (!st.scale && scores.length) {
      /* Zeroes are excluded, exactly as medianNotability does for RAWG. A
         great many Wikidata game items have no Wikipedia article at all, so
         the raw median of a window is usually 0 — which made the scale 0,
         collapsed the floor to nothing, and left the slider doing nothing at
         all when Wikidata was the only source. */
      const xs = scores.filter(v => v > 0).sort((a, b) => a - b);
      if (xs.length) {
        const mid = Math.floor(xs.length / 2);
        st.scale = xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
      }
    }

    st.wd = { count: n, only: !st.rows.some(x => x.source !== 'wikidata') };
  }

  /* Measured across a live sample: Hades 30, Pentiment 15, Sir Brante 4,
     Peglin 3. A median of about 4 is what an ordinary listed game scores, so
     that is the value mapped onto RAWG's own median. */
  const WD_MEDIAN_SITELINKS = 4;

  function titleKey(stub) {
    const p = MT.util.sortKeyToParts(stub.release.sortKey);
    return `${MT.util.normalizeTitle(stub.title)}|${p ? p.y : '?'}`;
  }

  function fetchPage(kind, win, page, meta) {
    const from = MT.util.skToISO(win.from);
    const to = MT.util.skToISO(win.to);
    if (kind === 'game') return MT.rawg.releasesBetween(from, to, { limit: 20, page, meta });
    return MT.tmdb.releasesBetween(kind, from, to, { page, meta });
  }

  /* TMDB exposes `popularity`; RAWG has no equivalent for unreleased games, so
     `added` — the number of users holding it in a library — stands in. */
  function notabilityOf(raw, kind) {
    const v = kind === 'game' ? raw.added : raw.popularity;
    return typeof v === 'number' && isFinite(v) ? v : 0;
  }

  function medianNotability(raw, kind) {
    const xs = raw.map(r => notabilityOf(r, kind)).filter(v => v > 0).sort((a, b) => a - b);
    if (!xs.length) return 0;
    const mid = Math.floor(xs.length / 2);
    return xs.length % 2 ? xs[mid] : (xs[mid - 1] + xs[mid]) / 2;
  }

  async function absorb(st, raw, kind, win) {
    const owned = new Map();
    for (const it of await MT.repo.allItems()) owned.set(it.uid, it.user.status);

    const added = [];
    for (const r of raw) {
      const score = notabilityOf(r, kind);
      /* Kept against the NOISE floor, not the slider's — the slider filters
         what is displayed, so everything it might reveal must already be
         here. */
      if (score < st.noise) { st.belowNoise++; continue; }

      let stub;
      try {
        stub = kind === 'game'
          ? MT.normalize.stubFromRawgSearch(r)
          : MT.normalize.stubFromTmdbSearch(r);
      } catch (_) { continue; }
      if (!stub || !stub.title) continue;
      if (st.seen.has(stub.uid)) continue;        // pages can overlap
      if (!stub.release || stub.release.precision !== 'day') { st.dropped++; continue; }

      /* With `region` set, TMDB filters on the REGIONAL release date but hands
         back the PRIMARY one — so a re-release arrives looking like a 1971
         film opening next Friday. Whatever is about to be printed under a day
         heading has to actually fall under it. */
      const sk = stub.release.sortKey;
      if (sk < win.from || sk > win.to) { st.dropped++; continue; }

      st.seen.add(stub.uid);
      st.titles.add(titleKey(stub));
      if (stub.ids && stub.ids.steam) {
        st.steam = st.steam || new Set();
        st.steam.add(String(stub.ids.steam));
      }
      const row = { stub, score, owned: owned.get(stub.uid) || null, source: 'rawg' };
      st.rows.push(row);
      added.push(row);
    }
    return added;
  }

  /* ── Rendering ────────────────────────────────────────────────────────── */

  function visible(st) {
    const floor = floorOf(st);
    return st.rows.filter(r =>
      r.score >= floor &&
      (!filterText || r.stub.title.toLowerCase().includes(filterText)));
  }

  /* Date first, then notability inside the day. The score is never shown; it
     only decides who leads a Friday. */
  function ordered(st) {
    return visible(st).sort((a, b) =>
      (a.stub.release.sortKey - b.stub.release.sortKey) || (b.score - a.score));
  }

  /* Pages arrive in notability order but display in date order, so a new page
     can insert anywhere — including above what is being read. Rebuilds are
     therefore anchored on the topmost visible row so the page does not jump
     under the user. */
  function rebuild(st) {
    const list = document.getElementById('relList');
    if (!list) return;
    const scroller = document.getElementById('viewScroll');

    let anchorUid = null, anchorOffset = 0, top = 0;
    if (scroller) {
      top = scroller.getBoundingClientRect().top;
      for (const el of list.querySelectorAll('[data-uid]')) {
        const r = el.getBoundingClientRect();
        if (r.bottom > top) { anchorUid = el.dataset.uid; anchorOffset = r.top - top; break; }
      }
    }

    let html = '';
    let lastKey = null;
    for (const r of ordered(st)) {
      const sk = r.stub.release.sortKey;
      if (sk !== lastKey) {
        html += `<div class="group-h group-h--sticky">${esc(dayHeading(sk))}</div>`;
        lastKey = sk;
      }
      html += row(r);
    }
    list.innerHTML = html;

    if (scroller && anchorUid) {
      const el = list.querySelector(`[data-uid="${anchorUid}"]`);
      if (el) scroller.scrollTop += (el.getBoundingClientRect().top - top) - anchorOffset;
    }
  }

  function foot(st) {
    const el = document.getElementById('relFoot');
    if (!el) return;

    if (st.error) {
      /* An outage and a dead connection look identical from the browser when
         the upstream sends errors without CORS headers, which RAWG does.
         MT.net.classify already probes a known-good host to tell them apart,
         so the least we can do is repeat which one it decided. */
      const k = st.error.kind;
      const title = k === 'offline' ? 'You appear to be offline'
                  : k === 'budget' || k === 'quota-soft' ? 'Request budget spent'
                  : k === 'auth' ? 'That API key was rejected'
                  : 'That source is not answering';
      /* If the fallback was tried too, say so — otherwise this reads as one
         service being down when in fact both were asked. */
      const alsoWd = st.wd && st.wd.failed
        ? ' Wikidata was tried as a fallback and did not answer either, so there is '
          + 'nothing to show for this window yet. Both are usually back within the hour.'
        : '';
      el.innerHTML = MT.ui.errorBox(title, (st.error.message || String(st.error)) + alsoWd)
        + '<div class="relnote"><button class="btn btn--sm" type="button" data-more="1">Try again</button></div>';
      return;
    }

    const shown = visible(st).length;
    const hiddenByNotability = st.rows.filter(r => r.score < floorOf(st)).length;

    if (!shown && !st.loading) {
      el.innerHTML = MT.ui.emptyState({
        title: 'Nothing to show here',
        body: hiddenByNotability
          ? `${MT.util.pluralize(hiddenByNotability, 'release')} in this window ${hiddenByNotability === 1 ? 'is' : 'are'}
             below the notability cut. Drag the slider left to bring ${hiddenByNotability === 1 ? 'it' : 'them'} back.`
          : filterText
            ? `Nothing loaded matches “${esc(filterText)}”.`
            : st.dropped
              ? `${MT.util.pluralize(st.dropped, 'title')} fall in this window but only have a year
                 or a month committed so far, so they are not listed. Widen the range, or follow
                 the people making them to hear when a date lands.`
              : 'No releases in this window. Try a wider range.',
      });
      return;
    }

    const bits = [];
    if (st.stale) {
      bits.push(`showing a saved copy from ${MT.util.timeAgo(st.stale.fetchedAt)}`);
    }
    if (st.wd && st.wd.count) {
      bits.push(`${st.wd.count} from Wikidata`);
    }
    bits.push(filterText
      ? `${shown} of ${st.rows.length} loaded match “${esc(filterText)}”`
      : MT.util.pluralize(shown, 'release'));
    if (hiddenByNotability && !filterText) {
      bits.push(`${hiddenByNotability} more below the notability cut`);
    }
    if (st.dropped) {
      bits.push(`${MT.util.pluralize(st.dropped, 'other')} dropped for having no firm date in this window`);
    }

    let action;
    if (st.loading) {
      action = '<div class="relspin">Loading more…</div>';
    } else if (st.capped) {
      action = `<div class="relnote muted">Stopped after ${RAWG_MAX_PAGES} pages to stay inside
        RAWG's monthly allowance. Narrow the range to see further ahead.</div>`;
    } else if (!st.done) {
      action = '<div class="relnote"><button class="btn btn--sm" type="button" data-more="1">Load more</button></div>';
    } else {
      action = '<div class="relnote muted">That is everything with a confirmed date in this window.</div>';
    }

    /* When RAWG is the missing half, say so plainly — the gap is real and
       specific (obscure and unannounced titles), not a general failure. */
    const banner = st.wd && st.wd.only && st.wd.count
      ? `<div class="relstale">RAWG is not answering, so this is the Wikidata list: well-known
           releases only. Smaller and newly announced games are missing until it is back.</div>`
      : st.stale
        ? `<div class="relstale">This list could not be refreshed, so it is the last copy saved
             ${esc(MT.util.timeAgo(st.stale.fetchedAt))}. Newly announced titles may be missing.</div>`
        : '';
    el.innerHTML = `${banner}<div class="relcount muted">${bits.join(' · ')}</div>${action}`;
  }

  /* ── Infinite scroll ──────────────────────────────────────────────────── */

  function watch(st, kind, range, win) {
    const sentinel = document.getElementById('relSentinel');
    const root = document.getElementById('viewScroll');
    if (!sentinel || !('IntersectionObserver' in window)) return;

    if (observer) observer.disconnect();
    const mine = token;
    observer = new IntersectionObserver(entries => {
      if (mine !== token) return;                 // route changed under us
      if (!entries.some(e => e.isIntersecting)) return;
      if (st.loading || st.done) return;
      loadPage(st, kind, range, win);
    }, {
      root: root || null,
      /* Start the next page before the user reaches the bottom, so a fast
         scroll does not hit a wall. */
      rootMargin: '600px 0px',
    });
    observer.observe(sentinel);
  }

  /* ── Rows ─────────────────────────────────────────────────────────────── */

  function dayHeading(sk) {
    const p = MT.util.sortKeyToParts(sk);
    if (!p) return 'No date';
    const days = MT.util.daysUntil(sk);
    const rel = days === 0 ? 'today' : days === 1 ? 'tomorrow' : MT.util.relativeDays(days);
    return `${MT.util.MONTHS[p.m - 1]} ${p.d}, ${p.y} · ${rel}`;
  }

  function row(r) {
    const s = r.stub;
    return `<div class="miss" data-uid="${esc(s.uid)}">
      ${MT.ui.chipart(s)}
      <div style="min-width:0;flex:1">
        <div style="font-weight:500;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(s.title)}</div>
        <div class="muted" style="font-size:var(--mt-fs-mini);display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          ${MT.ui.kindTag(s)} ${MT.ui.dateField(s.release)}
        </div>
      </div>
      ${r.owned
        ? `<span class="add is-in">✓ ${MT.ui.STATUS_WORD[r.owned] || 'In index'}</span>`
        : `<button class="add" type="button" data-add="${esc(s.uid)}" aria-label="Add ${esc(s.title)}">Add</button>`}
    </div>`;
  }

  function skeletonRows() {
    let s = '';
    for (let i = 0; i < 8; i++) {
      s += `<div class="miss"><div class="skel" style="width:20px;height:28px;border-radius:var(--mt-radius-sm)"></div>
        <div style="flex:1"><div class="skel skel--line" style="width:52%"></div>
        <div class="skel skel--line" style="width:30%;margin-top:6px"></div></div></div>`;
    }
    return s;
  }

  return { render };
})();
