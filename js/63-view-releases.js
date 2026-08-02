/* ══════════════════════════════════════════════════════════════════════════
   #/releases — what is coming out, whether or not you are tracking it.

   NOT to be confused with #/up "Coming Up", which plots the release dates of
   titles already in your index. This is the opposite: discovery. Nothing here
   is yours yet, and every row carries an Add button.

   Four rules shape the whole view.

   1 · "Anything with a fixed known date." A window query returns plenty of
       titles whose date is a Jan-1 placeholder meaning "sometime in 2027";
       derivePrecision demotes those to year precision and flags them inferred.
       Showing them under a heading that promises a date would be a lie the
       user acts on, so only precision === 'day' survives. The count dropped is
       disclosed rather than silently swallowed.

   2 · Obscurity is filtered RELATIVE to the window, never against a fixed
       number. Measured against the live API: an unfiltered week returns 319
       films, this week's most popular scores 15.3, next month's 46.8, and a
       year out the entire top five sits between 1.6 and 2.0 — and that five is
       Turtles, Bluey and Narnia. A fixed floor either floods this week or
       empties next year. So the scale is the MEDIAN popularity of the window's
       own first page, and the levels are multiples of it. Median rather than
       maximum because one runaway hit (next month's 46.8 against a 10.5
       runner-up) would otherwise drag the floor over genuinely notable films.

   3 · The API is always asked for popularity order, which is what makes paging
       terminate: once results fall below the floor, so does everything after
       them. Chronological display is therefore a client-side re-sort of a set
       that is small and bounded, rather than an endless one.

   4 · Pages append; they never re-render what is already there. Rebuilding a
       300-row list on each page would both stutter and shift the content the
       user is reading. The only full rebuild is when the filter changes, which
       is user-initiated and expected.

   5 · One request per page, one page in flight at a time, and nothing until
       the route is opened. Boot still costs zero.
   ══════════════════════════════════════════════════════════════════════════ */

MT.viewReleases = (function () {
  const esc = MT.util.escapeHtml;

  const KINDS = [
    { id: 'movie', label: 'Film' },
    { id: 'tv',    label: 'TV' },
    { id: 'game',  label: 'Games' },
    { id: 'anime', label: 'Anime' },
  ];

  const SORTS = [
    { id: 'notable', label: 'Notable first' },
    { id: 'date',    label: 'By date' },
  ];

  /* Multiples of the window's own median popularity. `all` still carries a
     small floor because the true tail is inert: page 10 of an unfiltered week
     scores 0.34, which is a record with a title and nothing else. */
  const TIERS = [
    { id: 'major',   label: 'Major only', k: 2.5 },
    { id: 'notable', label: 'Notable',    k: 1.0 },
    { id: 'all',     label: 'Everything', k: 0 },
  ];
  const NOISE_FLOOR = 0.3;

  /* RAWG allows 20,000 requests a month against a view that could otherwise
     page forever. TMDB has no such limit, so only games are capped — and when
     the cap is reached it says so rather than looking like the end of the
     catalogue. */
  const RAWG_MAX_PAGES = 10;

  /* Keyed `kind|range|sort`. Session-lived and dropped when the day rolls
     over, because every window is anchored to today. */
  const state = new Map();
  let day = MT.util.todaySortKey();

  let observer = null;
  let token = 0;
  let touchStart = null;
  let moved = false;
  let filterText = '';

  function keyOf(kind, range, tier) { return `${kind}|${range}|${tier}`; }

  function freshState() {
    return {
      rows: [], seen: new Set(), dropped: 0,
      page: 0, totalPages: null, total: 0,
      done: false, loading: false, capped: false,
      lastHead: null,
      scale: null,        // median popularity of page 1, set once
      belowFloor: 0,      // dropped for obscurity, disclosed not hidden
    };
  }

  async function render(params, query) {
    const view = document.getElementById('view');
    const q = query || {};
    const kind = KINDS.some(k => k.id === q.kind) ? q.kind : 'movie';
    const range = MT.util.RELEASE_RANGES.some(r => r.id === q.range) ? q.range : 'month';
    const sort = SORTS.some(s => s.id === q.sort) ? q.sort : 'notable';
    const tier = TIERS.some(t => t.id === q.tier) ? q.tier : 'notable';

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
        <div class="spacer"></div>
        <div class="seg" id="relSort">
          ${SORTS.map(s => `<button type="button" data-sort="${s.id}"
            aria-pressed="${s.id === sort}">${esc(s.label)}</button>`).join('')}
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
        <select id="relTier" class="chip" aria-label="How obscure to go">
          ${TIERS.map(t => `<option value="${t.id}"${t.id === tier ? ' selected' : ''}
            >${esc(t.label)}</option>`).join('')}
        </select>
        <span class="relwin mono faint">${esc(MT.util.skToISO(win.from))} → ${esc(MT.util.skToISO(win.to))}</span>
      </div>
      <div id="relBody">
        <div id="relList"></div>
        <div id="relSentinel" aria-hidden="true"></div>
        <div id="relFoot"></div>
      </div>`;

    wire(view, kind, range, sort, tier);

    const key = keyOf(kind, range, tier);
    if (!state.has(key)) state.set(key, freshState());
    const st = state.get(key);

    if (st.rows.length) {
      rebuild(st, kind);          // cached: repaint everything we already have
      foot(st);
      watch(st, kind, range, tier, win);
    } else {
      document.getElementById('relList').innerHTML = skeletonRows();
      loadPage(st, kind, range, tier, win).then(() => watch(st, kind, range, tier, win));
    }
  }

  function wire(view, kind, range, sort, tier) {
    const go = patch => {
      const n = Object.assign({ kind, range, sort, tier }, patch);
      MT.router.go(`#/releases?kind=${n.kind}&range=${n.range}&sort=${n.sort}&tier=${n.tier}`);
    };

    /* Assignment, not addEventListener — #view outlives the route. */
    view.onclick = async e => {
      const k = e.target.closest('[data-kind]');
      if (k) return go({ kind: k.dataset.kind });
      const r = e.target.closest('[data-range]');
      if (r) return go({ range: r.dataset.range });
      const s = e.target.closest('[data-sort]');
      if (s) return go({ sort: s.dataset.sort });

      const more = e.target.closest('[data-more]');
      if (more) {
        const st = state.get(keyOf(kind, range, tier));
        if (st && !st.loading && !st.done) {
          await loadPage(st, kind, range, tier, MT.util.releaseWindow(range));
        }
        return;
      }

      const addBtn = e.target.closest('[data-add]');
      if (addBtn) {
        if (suppressTap()) return;
        const st = state.get(keyOf(kind, range, tier));
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

    /* Filtering rebuilds only the list. The input lives outside it and is
       never touched, so the caret cannot be moved out from under a typist. */
    const sel = document.getElementById('relTier');
    if (sel) sel.onchange = () => go({ tier: sel.value });

    const f = document.getElementById('relFilter');
    if (f) {
      f.oninput = MT.util.debounce(() => {
        filterText = f.value.trim().toLowerCase();
        const st = state.get(keyOf(kind, range, tier));
        if (!st) return;
        rebuild(st, kind);
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

  async function loadPage(st, kind, range, tier, win) {
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
       qualifying. */
    if (st.scale == null) st.scale = medianNotability(env.results, kind);
    const floor = floorFor(st, tier);

    const added = await absorb(st, env.results, kind, win, floor);

    /* Results arrive in notability order, so once a page ends below the floor
       every later page does too. This is what stops paging without needing to
       walk the whole catalogue. */
    if (floor > 0 && env.results.length) {
      const lastScore = notabilityOf(env.results[env.results.length - 1], kind);
      if (lastScore < floor) st.done = true;
    }

    st.page = next;
    st.total = env.total || st.total;
    st.totalPages = env.totalPages;
    st.loading = false;
    st.error = null;

    if (kind === 'game' && next >= RAWG_MAX_PAGES) { st.capped = true; st.done = true; }
    if (env.totalPages != null && next >= env.totalPages) st.done = true;
    if (!env.results.length) st.done = true;

    if (st.page === 1) document.getElementById('relList').innerHTML = '';
    append(st, added, kind);
    foot(st);

    /* A page can be entirely placeholders, which would leave the list looking
       finished while more exists. Pull the next one rather than stalling. */
    if (!added.length && !st.done) await loadPage(st, kind, range, tier, win);
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

  function floorFor(st, tier) {
    const t = TIERS.find(x => x.id === tier) || TIERS[1];
    if (!t.k) return NOISE_FLOOR;
    return Math.max(NOISE_FLOOR, (st.scale || 0) * t.k);
  }

  async function absorb(st, raw, kind, win, floor) {
    const owned = new Map();
    for (const it of await MT.repo.allItems()) owned.set(it.uid, it.user.status);

    const added = [];
    for (const r of raw) {
      if (notabilityOf(r, kind) < floor) { st.belowFloor++; continue; }

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
         back the PRIMARY one — so a re-release arrives looking like a 1971 film
         opening next Friday. Whatever we are about to print under a day heading
         has to actually fall under it. */
      const sk = stub.release.sortKey;
      if (sk < win.from || sk > win.to) { st.dropped++; continue; }

      st.seen.add(stub.uid);
      const row = { stub, owned: owned.get(stub.uid) || null };
      st.rows.push(row);
      added.push(row);
    }
    return added;
  }

  /* ── Rendering ────────────────────────────────────────────────────────── */

  const matches = r => !filterText || r.stub.title.toLowerCase().includes(filterText);

  function chunkHtml(rows, byDay, headState) {
    let html = '';
    for (const r of rows) {
      if (!matches(r)) continue;
      if (byDay) {
        const sk = r.stub.release.sortKey;
        if (sk !== headState.last) {
          html += `<div class="group-h group-h--sticky">${esc(dayHeading(sk))}</div>`;
          headState.last = sk;
        }
      }
      html += row(r);
    }
    return html;
  }

  /* Appends only. Never touches rows already on screen. */
  function append(st, rows, kind) {
    if (!rows.length) return;
    /* Date mode has to re-sort, so it rebuilds. That is affordable only
       because the floor keeps the set small; notability mode, which can run
       long, appends and never touches what is on screen. */
    if (isByDay()) return rebuild(st, kind);
    const list = document.getElementById('relList');
    if (!list) return;
    const head = { last: st.lastHead };
    const html = chunkHtml(rows, false, head);
    st.lastHead = head.last;
    if (html) list.insertAdjacentHTML('beforeend', html);
  }

  /* Full rebuild — only on a filter change. */
  function rebuild(st, kind) {
    void kind;
    const list = document.getElementById('relList');
    if (!list) return;
    const head = { last: null };
    list.innerHTML = chunkHtml(ordered(st), isByDay(), head);
    st.lastHead = head.last;
  }

  function isByDay() {
    const b = document.querySelector('#relSort [data-sort][aria-pressed="true"]');
    return !!b && b.dataset.sort === 'date';
  }

  /* Chronological display is safe only because the floor bounds the set: we
     load everything above it and nothing after, so re-sorting converges
     instead of reshuffling forever. */
  function ordered(st) {
    if (!isByDay()) return st.rows;
    return st.rows.slice().sort((a, b) => a.stub.release.sortKey - b.stub.release.sortKey);
  }

  function foot(st) {
    const el = document.getElementById('relFoot');
    if (!el) return;

    const shown = st.rows.filter(matches).length;
    const bits = [];

    if (st.error) {
      el.innerHTML = MT.ui.errorBox('Could not load more releases',
        st.error.message || String(st.error))
        + '<div class="relnote"><button class="btn btn--sm" type="button" data-more="1">Try again</button></div>';
      return;
    }

    if (!st.rows.length && !st.loading) {
      el.innerHTML = MT.ui.emptyState({
        title: 'Nothing to show here',
        body: st.belowFloor
          ? `Everything releasing in this window is below the notability cut. Switch to
             Everything to see all ${st.belowFloor + st.dropped} of them.`
          : st.dropped
            ? `${MT.util.pluralize(st.dropped, 'title')} fall in this window but only have a year or
               a month committed so far, so they are not listed. Widen the range, or follow the
               people making them to hear when a date lands.`
            : 'No releases in this window. Try a wider range.',
      });
      return;
    }

    if (filterText) {
      bits.push(`${shown} of ${st.rows.length} loaded match “${esc(filterText)}”`);
    } else {
      bits.push(`${MT.util.pluralize(st.rows.length, 'title')} loaded`);
    }
    if (st.dropped) {
      bits.push(`${MT.util.pluralize(st.dropped, 'other')} dropped for having no firm date in this window`);
    }
    if (st.belowFloor) {
      bits.push(`${st.belowFloor} too obscure to list`);
    }

    let action = '';
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

  function watch(st, kind, range, tier, win) {
    const sentinel = document.getElementById('relSentinel');
    const root = document.getElementById('viewScroll');
    if (!sentinel || !('IntersectionObserver' in window)) return;

    if (observer) observer.disconnect();
    const mine = token;
    observer = new IntersectionObserver(entries => {
      if (mine !== token) return;                 // route changed under us
      if (!entries.some(e => e.isIntersecting)) return;
      if (st.loading || st.done) return;
      loadPage(st, kind, range, tier, win);
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
