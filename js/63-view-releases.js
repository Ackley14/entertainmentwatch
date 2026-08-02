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

   2 · Sort order is load-bearing once paging exists. Popularity puts notable
       titles first but scatters dates, so page 2 holds less popular films with
       EARLIER dates — re-sorting an accumulating list by date would reshuffle
       everything already on screen every time a page landed, under the user's
       thumb. Chronological pages arrive in order and append cleanly, so Date
       is the default and the only mode that draws day headings. Popular is
       offered too, and simply never regroups.

   3 · Pages append; they never re-render what is already there. Rebuilding a
       300-row list on each page would both stutter and shift the content the
       user is reading. The only full rebuild is when the filter changes, which
       is user-initiated and expected.

   4 · One request per page, one page in flight at a time, and nothing until
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
    { id: 'date',    label: 'By date' },
    { id: 'popular', label: 'Most popular' },
  ];

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

  function keyOf(kind, range, sort) { return `${kind}|${range}|${sort}`; }

  function freshState() {
    return {
      rows: [], seen: new Set(), dropped: 0,
      page: 0, totalPages: null, total: 0,
      done: false, loading: false, capped: false,
      lastHead: null,
    };
  }

  async function render(params, query) {
    const view = document.getElementById('view');
    const q = query || {};
    const kind = KINDS.some(k => k.id === q.kind) ? q.kind : 'movie';
    const range = MT.util.RELEASE_RANGES.some(r => r.id === q.range) ? q.range : 'month';
    const sort = SORTS.some(s => s.id === q.sort) ? q.sort : 'date';

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
        <span class="relwin mono faint">${esc(MT.util.skToISO(win.from))} → ${esc(MT.util.skToISO(win.to))}</span>
      </div>
      <div id="relBody">
        <div id="relList"></div>
        <div id="relSentinel" aria-hidden="true"></div>
        <div id="relFoot"></div>
      </div>`;

    wire(view, kind, range, sort);

    const key = keyOf(kind, range, sort);
    if (!state.has(key)) state.set(key, freshState());
    const st = state.get(key);

    if (st.rows.length) {
      rebuild(st, kind);          // cached: repaint everything we already have
      foot(st);
      watch(st, kind, range, sort, win);
    } else {
      document.getElementById('relList').innerHTML = skeletonRows();
      loadPage(st, kind, range, sort, win).then(() => watch(st, kind, range, sort, win));
    }
  }

  function wire(view, kind, range, sort) {
    const go = patch => {
      const n = Object.assign({ kind, range, sort }, patch);
      MT.router.go(`#/releases?kind=${n.kind}&range=${n.range}&sort=${n.sort}`);
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
        const st = state.get(keyOf(kind, range, sort));
        if (st && !st.loading && !st.done) {
          await loadPage(st, kind, range, sort, MT.util.releaseWindow(range));
        }
        return;
      }

      const addBtn = e.target.closest('[data-add]');
      if (addBtn) {
        if (suppressTap()) return;
        const st = state.get(keyOf(kind, range, sort));
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
    const f = document.getElementById('relFilter');
    if (f) {
      f.oninput = MT.util.debounce(() => {
        filterText = f.value.trim().toLowerCase();
        const st = state.get(keyOf(kind, range, sort));
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

  async function loadPage(st, kind, range, sort, win) {
    if (st.loading || st.done) return;
    const mine = token;
    st.loading = true;
    foot(st);

    const next = st.page + 1;
    let env;
    try {
      env = await fetchPage(kind, win, next, sort);
    } catch (e) {
      if (mine !== token) return;
      st.loading = false;
      st.error = e;
      foot(st);
      return;
    }
    if (mine !== token) { st.loading = false; return; }

    const added = await absorb(st, env.results, kind);

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
    if (!added.length && !st.done) await loadPage(st, kind, range, sort, win);
  }

  function fetchPage(kind, win, page, sort) {
    const from = MT.util.skToISO(win.from);
    const to = MT.util.skToISO(win.to);
    if (kind === 'game') return MT.rawg.releasesBetween(from, to, { limit: 20, page, sort });
    return MT.tmdb.releasesBetween(kind, from, to, { page, sort });
  }

  async function absorb(st, raw, kind) {
    const owned = new Map();
    for (const it of await MT.repo.allItems()) owned.set(it.uid, it.user.status);

    const added = [];
    for (const r of raw) {
      let stub;
      try {
        stub = kind === 'game'
          ? MT.normalize.stubFromRawgSearch(r)
          : MT.normalize.stubFromTmdbSearch(r);
      } catch (_) { continue; }
      if (!stub || !stub.title) continue;
      if (st.seen.has(stub.uid)) continue;        // pages can overlap
      if (!stub.release || stub.release.precision !== 'day') { st.dropped++; continue; }
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
    void kind;
    const list = document.getElementById('relList');
    if (!list || !rows.length) return;
    const head = { last: st.lastHead };
    const html = chunkHtml(rows, isByDay(), head);
    st.lastHead = head.last;
    if (html) list.insertAdjacentHTML('beforeend', html);
  }

  /* Full rebuild — only on a filter change. */
  function rebuild(st, kind) {
    void kind;
    const list = document.getElementById('relList');
    if (!list) return;
    const head = { last: null };
    list.innerHTML = chunkHtml(st.rows, isByDay(), head);
    st.lastHead = head.last;
  }

  function isByDay() {
    const b = document.querySelector('#relSort [data-sort][aria-pressed="true"]');
    return !b || b.dataset.sort === 'date';
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
        title: 'Nothing with a confirmed date',
        body: st.dropped
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
      bits.push(`${MT.util.pluralize(st.dropped, 'other')} in this window ${st.dropped === 1 ? 'has' : 'have'} only a year or month announced`);
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

  function watch(st, kind, range, sort, win) {
    const sentinel = document.getElementById('relSentinel');
    const root = document.getElementById('viewScroll');
    if (!sentinel || !('IntersectionObserver' in window)) return;

    if (observer) observer.disconnect();
    const mine = token;
    observer = new IntersectionObserver(entries => {
      if (mine !== token) return;                 // route changed under us
      if (!entries.some(e => e.isIntersecting)) return;
      if (st.loading || st.done) return;
      loadPage(st, kind, range, sort, win);
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
