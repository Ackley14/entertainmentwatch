/* ══════════════════════════════════════════════════════════════════════════
   Pane 1 — the index tree. This is the app's navigation.

   Every destination in MovieTrak is a node here, so the tree is built from
   live counts rather than a static list: statuses, media types, tags and
   followed people all appear only when they exist. Route state drives
   selection, never the other way round, so a hash typed by hand or restored
   from a bookmark still highlights correctly.
   ══════════════════════════════════════════════════════════════════════════ */

MT.tree = (function () {
  const esc = MT.util.escapeHtml;
  const OPEN_KEY = 'mt.tree.open.v1';
  let open = load();
  let nodes = [];          // flat, in visual order — the keyboard's world
  let focusIdx = -1;
  let filterText = '';

  function load() {
    try { return JSON.parse(localStorage.getItem(OPEN_KEY)) || {}; }
    catch (_) { return {}; }
  }
  function persist() {
    try { localStorage.setItem(OPEN_KEY, JSON.stringify(open)); } catch (_) {}
  }
  const isOpen = id => open[id] !== 0;   // default open

  const CARET = '<span class="tri"><svg viewBox="0 0 12 12" fill="currentColor" aria-hidden="true"><path d="M2 4l4 4 4-4z"/></svg></span>';
  const NOCARET = '<span class="tri void"></span>';

  async function build() {
    const items = await MT.repo.allItems();
    const follows = await MT.repo.allFollows();
    const unread = await MT.repo.unreadCount();

    const byStatus = { want: 0, watching: 0, watched: 0, dropped: 0 };
    const byKind = { film: 0, tv: 0, game: 0, anime: 0 };
    const tags = new Map();
    let undated = 0;
    const today = MT.util.todaySortKey();
    let upcoming = 0;

    for (const it of items) {
      byStatus[it.user.status] = (byStatus[it.user.status] || 0) + 1;
      byKind[MT.ui.kindOf(it)]++;
      for (const t of (it.user.tags || [])) tags.set(t, (tags.get(t) || 0) + 1);
      if (it.release.sortKey >= MT.util.SK_UNKNOWN) undated++;
      else if (it.release.sortKey >= today) upcoming++;
    }

    return [
      { id: 'library', label: 'Library', children: [
        { id: 'all', label: 'All titles', route: '#/library', n: items.length },
        { id: 'st-want', label: 'Want', route: '#/library?status=want', n: byStatus.want, dot: 'want' },
        { id: 'st-watching', label: 'Watching', route: '#/library?status=watching', n: byStatus.watching, dot: 'watching', fill: 1 },
        { id: 'st-watched', label: 'Finished', route: '#/library?status=watched', n: byStatus.watched, dot: 'watched' },
        { id: 'st-dropped', label: 'Dropped', route: '#/library?status=dropped', n: byStatus.dropped, dot: 'dropped' },
        { id: 'types', label: 'By type', children: [
          { id: 'k-film', label: 'Film', route: '#/library?kind=movie', n: byKind.film, dot: 'film' },
          { id: 'k-tv', label: 'Television', route: '#/library?kind=tv', n: byKind.tv, dot: 'tv' },
          { id: 'k-game', label: 'Games', route: '#/library?kind=game', n: byKind.game, dot: 'game' },
          { id: 'k-anime', label: 'Anime', route: '#/library?kind=anime', n: byKind.anime, dot: 'anime' },
        ] },
      ] },
      { id: 'schedule', label: 'Schedule', children: [
        { id: 'up', label: 'Coming up', route: '#/up', n: upcoming },
        { id: 'undated', label: 'No date set', route: '#/up?undated=1', n: undated },
        { id: 'activity', label: 'Activity', route: '#/alerts', badge: unread || 0 },
        { id: 'stats', label: 'Stats', route: '#/stats' },
      ] },
      { id: 'discover', label: 'Discover', children: [
        { id: 'search', label: 'Search', route: '#/search' },
        /* "Releases" is discovery — things you do NOT have. Distinct from
           "Coming Up", which plots dates for titles already in the index. */
        { id: 'releases', label: 'Releases', route: '#/releases' },
        { id: 'recs', label: 'For you', route: '#/recs' },
        { id: 'people', label: 'Following', route: '#/people', n: follows.length },
      ] },
      tags.size ? { id: 'tags', label: 'Tags', children:
        [...tags.entries()].sort((a, b) => b[1] - a[1]).map(([t, n]) => ({
          id: 'tag-' + t, label: t, route: '#/library?tag=' + encodeURIComponent(t), n, hash: true,
        })) } : null,
      { id: 'system', label: 'System', children: [
        { id: 'settings', label: 'Settings', route: '#/settings' },
        { id: 'unlock', label: MT.crypto.isUnlocked() ? 'Signed in' : 'Sign in', route: '#/unlock' },
      ] },
    ].filter(Boolean);
  }

  function matches(node) {
    if (!filterText) return true;
    if (node.label.toLowerCase().includes(filterText)) return true;
    return (node.children || []).some(matches);
  }

  function render(sections, activeRoute) {
    nodes = [];
    let html = '';
    for (const sec of sections) {
      if (!matches(sec)) continue;
      const secOpen = isOpen(sec.id) || !!filterText;
      html += `<div class="sec" data-open="${secOpen ? 1 : 0}">
        <button class="sec-h" data-toggle="${esc(sec.id)}" type="button">
          ${CARET}<span>${esc(sec.label)}</span>
        </button>
        <div class="sec-body">${sec.children.map(c => renderNode(c, activeRoute)).join('')}</div>
      </div>`;
    }
    return html;
  }

  function renderNode(node, activeRoute) {
    if (!matches(node)) return '';
    const sel = node.route && routeMatches(node.route, activeRoute);
    if (sel) focusIdx = nodes.length;
    nodes.push(node);

    const lead = node.dot ? `<span class="dot c-${esc(node.dot)}${node.fill ? ' fill' : ''}"></span>`
               : node.hash ? '<span class="hash">#</span>' : '';
    const trail = node.badge ? `<span class="badge">${node.badge}</span>`
                : node.n != null ? `<span class="n">${node.n}</span>` : '';

    if (node.children) {
      const o = isOpen(node.id) || !!filterText;
      return `<div class="grp" data-open="${o ? 1 : 0}">
        <button class="row" type="button" data-toggle="${esc(node.id)}">
          ${CARET}${lead}<span class="lbl">${esc(node.label)}</span>${trail}
        </button>
        <div class="kids">${node.children.map(c => renderNode(c, activeRoute)).join('')}</div>
      </div>`;
    }
    return `<a class="row${sel ? ' is-sel' : ''}" href="${esc(node.route)}" data-node="${esc(node.id)}">
      ${NOCARET}${lead}<span class="lbl">${esc(node.label)}</span>${trail}
    </a>`;
  }

  /* A node is selected when its route's path and its own query pairs are all
     present in the current hash. That way "#/library?status=want&kind=tv"
     still highlights Want, and plain "#/library" highlights All titles. */
  function routeMatches(route, active) {
    const [rp, rq] = route.replace('#', '').split('?');
    const [ap, aq] = (active || '').replace('#', '').split('?');
    if (rp !== ap) return false;
    const A = new URLSearchParams(aq || '');
    const R = new URLSearchParams(rq || '');
    if (![...R].length) return ![...A].some(([k]) => k === 'status' || k === 'kind' || k === 'tag' || k === 'undated');
    for (const [k, v] of R) if (A.get(k) !== v) return false;
    return true;
  }

  async function refresh() {
    const host = document.getElementById('tree');
    if (!host) return;
    const sections = await build();
    host.innerHTML = render(sections, location.hash || '#/library');
    paintFocus();
  }

  function paintFocus() {
    const rows = [...document.querySelectorAll('#tree a.row')];
    rows.forEach(r => r.classList.remove('is-focus'));
    if (focusIdx >= 0 && rows[focusIdx]) rows[focusIdx].classList.add('is-focus');
  }

  function init() {
    const host = document.getElementById('tree');
    const filter = document.getElementById('treeFilter');

    host.addEventListener('click', e => {
      const toggle = e.target.closest('[data-toggle]');
      if (toggle) {
        e.preventDefault();
        const id = toggle.dataset.toggle;
        open[id] = isOpen(id) ? 0 : 1;
        persist();
        refresh();
        return;
      }
      /* On narrow screens the tree is a drawer; picking something closes it. */
      if (e.target.closest('a.row') && window.innerWidth <= 820) closeDrawer();
    });

    filter.addEventListener('input', MT.util.debounce(() => {
      filterText = filter.value.trim().toLowerCase();
      refresh();
    }, 120));
    filter.addEventListener('keydown', e => {
      if (e.key === 'Escape') { filter.value = ''; filterText = ''; refresh(); filter.blur(); }
      if (e.key === 'Enter') {
        const first = document.querySelector('#tree a.row');
        if (first) { location.hash = first.getAttribute('href'); filter.blur(); }
      }
    });

    document.addEventListener('keydown', e => {
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
      if (typing) return;

      if (e.key === '/') { e.preventDefault(); filter.focus(); filter.select(); return; }
      if (e.key === 't' || e.key === 'T') { MT.theme.toggle(); return; }

      const rows = [...document.querySelectorAll('#tree a.row')];
      if (!rows.length) return;
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        e.preventDefault();
        focusIdx = e.key === 'ArrowDown'
          ? Math.min(rows.length - 1, focusIdx + 1)
          : Math.max(0, focusIdx - 1);
        paintFocus();
        rows[focusIdx].scrollIntoView({ block: 'nearest' });
      } else if (e.key === 'Enter' && focusIdx >= 0) {
        location.hash = rows[focusIdx].getAttribute('href');
      } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
        const grp = rows[focusIdx] && rows[focusIdx].closest('.grp, .sec');
        if (!grp) return;
        const btn = grp.querySelector('[data-toggle]');
        if (!btn) return;
        const id = btn.dataset.toggle;
        const wantOpen = e.key === 'ArrowRight';
        if (isOpen(id) !== wantOpen) { open[id] = wantOpen ? 1 : 0; persist(); refresh(); }
      }
    });

    document.getElementById('menuBtn').addEventListener('click', openDrawer);
    document.getElementById('scrim').addEventListener('click', () => {
      document.getElementById('treePane').classList.remove('open');
      MT.inspector.close();
      document.getElementById('scrim').classList.remove('on');
    });

    for (const mq of [MQ_TREE_DRAWER, MQ_INSP_DRAWER]) {
      if (mq.addEventListener) mq.addEventListener('change', syncDrawers);
      else if (mq.addListener) mq.addListener(syncDrawers);
    }
    /* Width only. With interactive-widget=resizes-content, opening the
       on-screen keyboard resizes the viewport HEIGHT on every focus — and
       re-running the drawer sync on each of those was a visible stutter while
       typing. No breakpoint in this app is keyed on height. */
    let lastW = window.innerWidth;
    window.addEventListener('resize', MT.util.debounce(() => {
      if (window.innerWidth === lastW) return;
      lastW = window.innerWidth;
      syncDrawers();
    }, 150));

    MT.repo.subscribe(ev => {
      if (ev === 'item:put' || ev === 'item:delete' || ev === 'feed:change' ||
          ev === 'follow:change' || ev === 'import:done' || ev === 'wipe') refresh();
    });
  }

  /* ── Breakpoint state ──────────────────────────────────────────────────
     The drawers are CSS below a width and docked above it, but the .open class
     that drives them is set by JS. Unfolding a phone into a tablet is a RESIZE,
     not a reload: the classes survive while the CSS giving them meaning does
     not. Left alone, unfolding with the tree open leaves a full-screen scrim
     that nothing can clear, and dragging a desktop window narrower slides the
     inspector you were reading off the edge.

     These queries mirror css/05-responsive.css exactly; changing one means
     changing the other. */
  const MQ_TREE_DRAWER = matchMedia('(max-width: 820px)');
  const MQ_INSP_DRAWER = matchMedia('(max-width: 1180px) and (pointer: coarse)');

  function syncDrawers() {
    const tree = document.getElementById('treePane');
    const insp = document.getElementById('inspector');
    const scrim = document.getElementById('scrim');
    if (!tree || !insp || !scrim) return;

    if (!MQ_TREE_DRAWER.matches) tree.classList.remove('open');
    /* The inspector is docked on tablets and foldables, so "open" is only
       meaningful where it is actually an overlay. */
    if (!isInspOverlay()) insp.classList.remove('open');
    scrim.classList.toggle('on',
      (MQ_TREE_DRAWER.matches && tree.classList.contains('open')) ||
      (isInspOverlay() && insp.classList.contains('open')));
  }

  /* Docked wherever there is room for two panes on a touch device; an overlay
     otherwise. Mirrors the CSS band in §6 of 05-responsive.css. */
  function isInspOverlay() {
    return window.innerWidth <= 1180 && !MQ_INSP_DRAWER.matches
      ? true                                  // narrow mouse window: overlay
      : window.innerWidth <= 820;             // touch: overlay only on phones
  }

  function openDrawer() {
    /* See MT.inspector.openDrawerIfNarrow — one drawer at a time. */
    MT.inspector.close();
    document.getElementById('treePane').classList.add('open');
    document.getElementById('scrim').classList.add('on');
  }
  function closeDrawer() {
    document.getElementById('treePane').classList.remove('open');
    if (!document.getElementById('inspector').classList.contains('open')) {
      document.getElementById('scrim').classList.remove('on');
    }
  }

  return { init, refresh, openDrawer, closeDrawer, syncDrawers, isInspOverlay };
})();
