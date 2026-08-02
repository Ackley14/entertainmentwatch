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

  function keyOf(kind, range) { return `${kind}|${range}`; }

  function freshState(kind) {
    return {
      noise: noiseFor(kind),
      rows: [], seen: new Set(), dropped: 0,
      page: 0, totalPages: null, total: 0,
      done: false, loading: false, capped: false,
      scale: null,        // median notability of page 1, set once
      belowNoise: 0,      // never kept at all
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

    /* Leaving the route must stop the scroll watcher, or it keeps firing
       against a list that is no longer on screen. */
    if (observer) { observer.disconnect(); observer = null; }
    token++;
    filterText = '';

    MT.ui.crumb(['Discover', 'Releases']);
    MT.ui.paneActions('');

    if (day !== MT.util.todaySortKey()) { state.clear(); day = MT.util.todaySortKey(); }

    const win = MT.util.releaseWindow(range);
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

    wire(view, kind, range, win);

    const key = keyOf(kind, range);
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

  function wire(view, kind, range, win) {
    const go = patch => {
      const n = Object.assign({ kind, range }, patch);
      MT.router.go(`#/releases?kind=${n.kind}&range=${n.range}`);
    };

    /* Assignment, not addEventListener — #view outlives the route. */
    view.onclick = async e => {
      const k = e.target.closest('[data-kind]');
      if (k) return go({ kind: k.dataset.kind });
      const r = e.target.closest('[data-range]');
      if (r) return go({ range: r.dataset.range });

      const more = e.target.closest('[data-more]');
      if (more) {
        const st = state.get(keyOf(kind, range));
        if (st && !st.loading && !st.done) await loadPage(st, kind, range, win);
        return;
      }

      const addBtn = e.target.closest('[data-add]');
      if (addBtn) {
        if (suppressTap()) return;
        const st = state.get(keyOf(kind, range));
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
    const nota = document.getElementById('relNota');
    if (nota) {
      /* Widening the cut can want pages we stopped fetching. Clearing `done`
         is not enough on its own: the observer fires on intersection CHANGES,
         and the sentinel is usually already visible at that moment, so nothing
         would load until the user happened to scroll. Kick it directly —
         debounced, because a drag emits an event per step. */
      const resume = MT.util.debounce(() => {
        const st = state.get(keyOf(kind, range));
        if (st && !st.done && !st.loading) loadPage(st, kind, range, win);
      }, 200);

      nota.oninput = () => {
        const prev = sliderPos;
        sliderPos = +nota.value;
        writeSlider(sliderPos);
        const st = state.get(keyOf(kind, range));
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
        const st = state.get(keyOf(kind, range));
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
    let env;
    try {
      env = await fetchPage(kind, win, next);
    } catch (e) {
      if (mine !== token) return;
      st.loading = false;
      st.error = e;
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
    if (added.length) rebuild(st);
    foot(st);

    /* A page can be entirely placeholders or all below the noise floor, which
       would leave the list looking finished while more exists. */
    if (!added.length && !st.done) await loadPage(st, kind, range, win);
  }

  function fetchPage(kind, win, page) {
    const from = MT.util.skToISO(win.from);
    const to = MT.util.skToISO(win.to);
    if (kind === 'game') return MT.rawg.releasesBetween(from, to, { limit: 20, page });
    return MT.tmdb.releasesBetween(kind, from, to, { page });
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
      const row = { stub, score, owned: owned.get(stub.uid) || null };
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
      el.innerHTML = MT.ui.errorBox('Could not load more releases',
        st.error.message || String(st.error))
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

    el.innerHTML = `<div class="relcount muted">${bits.join(' · ')}</div>${action}`;
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
