/* ══════════════════════════════════════════════════════════════════════════
   #/releases — what is coming out, whether or not you are tracking it.

   NOT to be confused with #/up "Coming Up", which plots the release dates of
   titles already in your index. This is the opposite: discovery. Nothing here
   is yours yet, and every row carries an Add button.

   Two rules shape the whole view.

   1 · "Anything with a fixed known date." A window query returns plenty of
       titles whose date is a Jan-1 placeholder meaning "sometime in 2027";
       derivePrecision demotes those to year precision and flags them inferred.
       Showing them under a heading that promises a date would be a lie the
       user acts on, so only precision === 'day' survives the filter. The count
       of what was dropped is shown rather than silently swallowed.

   2 · One request per view, ever. A kind and a range together identify exactly
       one API call, cached in-session and again by MT.net. Switching tabs or
       ranges costs one request the first time and nothing afterwards. Boot
       costs zero, because nothing here runs until the route is opened.
   ══════════════════════════════════════════════════════════════════════════ */

MT.viewReleases = (function () {
  const esc = MT.util.escapeHtml;

  const KINDS = [
    { id: 'movie', label: 'Film' },
    { id: 'tv',    label: 'TV' },
    { id: 'game',  label: 'Games' },
    { id: 'anime', label: 'Anime' },
  ];

  /* Keyed `kind|range`. Session-lived: the window itself is anchored to today,
     so a cache that outlived the day would answer "this week" with last week. */
  const cache = new Map();
  let cacheDay = MT.util.todaySortKey();

  let token = 0;
  let touchStart = null;
  let moved = false;

  async function render(params, query) {
    const view = document.getElementById('view');
    const q = query || {};
    const kind = KINDS.some(k => k.id === q.kind) ? q.kind : 'movie';
    const range = MT.util.RELEASE_RANGES.some(r => r.id === q.range) ? q.range : 'month';

    MT.ui.crumb(['Discover', 'Releases']);
    MT.ui.paneActions('');

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
      <div class="relwin mono faint">${esc(MT.util.skToISO(win.from))} → ${esc(MT.util.skToISO(win.to))}</div>
      <div id="relBody"></div>`;

    wire(view, kind, range);
    load(kind, range, win);
  }

  function wire(view, kind, range) {
    const go = patch => {
      const next = Object.assign({ kind, range }, patch);
      MT.router.go(`#/releases?kind=${next.kind}&range=${next.range}`);
    };

    /* Assignment, not addEventListener — #view outlives the route. */
    view.onclick = e => {
      const k = e.target.closest('[data-kind]');
      if (k) { go({ kind: k.dataset.kind }); return; }
      const r = e.target.closest('[data-range]');
      if (r) { go({ range: r.dataset.range }); return; }
    };

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

  /* A tap that followed finger movement is a scroll. Browsers still fire click
     after a short drag, which on a dense list means a flick adds whatever was
     under your thumb. */
  function suppressTap() {
    const was = moved;
    moved = false;
    return was;
  }

  async function load(kind, range, win) {
    const body = document.getElementById('relBody');
    const mine = ++token;

    /* The window is anchored to today, so yesterday's answers are wrong. */
    if (cacheDay !== MT.util.todaySortKey()) { cache.clear(); cacheDay = MT.util.todaySortKey(); }

    const key = `${kind}|${range}`;
    if (cache.has(key)) return paint(body, cache.get(key), kind);

    body.innerHTML = MT.ui.skeletonGrid ? skeletonRows() : '';

    let raw;
    try {
      raw = await fetchWindow(kind, win);
    } catch (e) {
      if (mine !== token) return;
      body.innerHTML = MT.ui.errorBox(errorTitle(kind, e), e.message || String(e));
      return;
    }
    if (mine !== token) return;

    const result = await buildRows(raw, kind);
    cache.set(key, result);
    if (mine !== token) return;
    paint(body, result, kind);
  }

  function errorTitle(kind, e) {
    if (kind === 'game') return 'Could not load game releases';
    return e && e.kind === 'auth' ? 'API key problem' : 'Could not load releases';
  }

  async function fetchWindow(kind, win) {
    const from = MT.util.skToISO(win.from);
    const to = MT.util.skToISO(win.to);
    if (kind === 'game') return MT.rawg.releasesBetween(from, to, { limit: 20 });
    return MT.tmdb.releasesBetween(kind, from, to);
  }

  async function buildRows(raw, kind) {
    const owned = new Map();
    for (const it of await MT.repo.allItems()) owned.set(it.uid, it.user.status);

    let dropped = 0;
    const rows = [];
    for (const r of raw) {
      let stub;
      try {
        stub = kind === 'game'
          ? MT.normalize.stubFromRawgSearch(r)
          : MT.normalize.stubFromTmdbSearch(r);
      } catch (_) { continue; }
      if (!stub || !stub.title) continue;

      /* The promise of this view is a fixed date. A placeholder that
         derivePrecision demoted is not one. */
      if (!stub.release || stub.release.precision !== 'day') { dropped++; continue; }

      rows.push({ stub, owned: owned.get(stub.uid) || null });
    }

    rows.sort((a, b) => a.stub.release.sortKey - b.stub.release.sortKey);
    return { rows, dropped };
  }

  function paint(body, result, kind) {
    const { rows, dropped } = result;

    if (!rows.length) {
      body.innerHTML = MT.ui.emptyState({
        title: 'Nothing with a confirmed date',
        body: dropped
          ? `${MT.util.pluralize(dropped, 'title')} fall in this window but only have a
             year or a month committed so far, so they are not shown here. Widen the range, or
             follow the people making them to hear when a date lands.`
          : 'No releases in this window. Try a wider range.',
      });
      return;
    }

    /* Grouped by day, because that is the question being asked. */
    let html = '';
    let lastKey = null;
    for (const r of rows) {
      const sk = r.stub.release.sortKey;
      if (sk !== lastKey) {
        html += MT.ui.groupHead(dayHeading(sk));
        lastKey = sk;
      }
      html += row(r);
    }

    if (dropped) {
      html += `<div class="relnote muted">${MT.util.pluralize(dropped, 'other title')}
        in this window ${dropped === 1 ? 'has' : 'have'} only a year or month announced,
        so ${dropped === 1 ? 'it is' : 'they are'} not listed.</div>`;
    }
    body.innerHTML = html;
    wireRows(body, kind);
  }

  function dayHeading(sk) {
    const p = MT.util.sortKeyToParts(sk);
    if (!p) return 'No date';
    const days = MT.util.daysUntil(sk);
    const rel = days === 0 ? 'today' : days === 1 ? 'tomorrow' : MT.util.relativeDays(days);
    return `${MT.util.MONTHS[p.m - 1]} ${p.d} · ${rel}`;
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

  function wireRows(body, kind) {
    void kind;
    /* Only the Add button adds; the row body opens the inspector. Same rule as
       search, for the same reason — a scroll that ends in a tap must not put
       something in your index. */
    body.onclick = async e => {
      const addBtn = e.target.closest('[data-add]');
      if (addBtn) {
        if (suppressTap()) return;
        const el = addBtn.closest('[data-uid]');
        const hit = findRow(el && el.dataset.uid);
        if (!hit || hit.owned) return;
        await MT.ui.addItem(hit.stub);
        hit.owned = 'want';
        addBtn.outerHTML = `<span class="add is-in">✓ Want</span>`;
        return;
      }
      const el = e.target.closest('[data-uid]');
      if (!el || suppressTap()) return;
      MT.inspector.show(el.dataset.uid);
    };
  }

  function findRow(uid) {
    if (!uid) return null;
    for (const v of cache.values()) {
      const hit = v.rows.find(r => r.stub.uid === uid);
      if (hit) return hit;
    }
    return null;
  }

  function skeletonRows() {
    let s = '';
    for (let i = 0; i < 6; i++) {
      s += `<div class="miss"><div class="skel" style="width:20px;height:28px;border-radius:var(--mt-radius-sm)"></div>
        <div style="flex:1"><div class="skel skel--line" style="width:52%"></div>
        <div class="skel skel--line" style="width:30%;margin-top:6px"></div></div></div>`;
    }
    return s;
  }

  return { render };
})();
