/* ══════════════════════════════════════════════════════════════════════════
   Hash router.

   Hash routing rather than the History API, because GitHub Pages returns a
   real HTTP 404 for any path it has no file for. The usual SPA workaround
   (a 404.html that re-serves the app) is a genuine hack we don't need — and
   on file:// the History API is unusable anyway.
   ══════════════════════════════════════════════════════════════════════════ */

MT.router = (function () {
  const routes = [];
  let current = null;
  let currentToken = 0;

  function on(pattern, handler) {
    /* '#/item/:uid' → captures everything after the prefix, including colons,
       because a uid is `movie:tmdb:550`. */
    const parts = pattern.split('/').filter(Boolean);
    routes.push({ pattern, parts, handler });
  }

  function parse(hash) {
    const raw = (hash || location.hash || '#/').replace(/^#/, '');
    const [pathPart, queryPart] = raw.split('?');
    const segs = pathPart.split('/').filter(Boolean);
    const query = {};
    if (queryPart) {
      for (const kv of queryPart.split('&')) {
        const [k, v] = kv.split('=');
        query[decodeURIComponent(k)] = decodeURIComponent(v || '');
      }
    }
    return { segs, query, path: pathPart || '/' };
  }

  function match(segs) {
    for (const r of routes) {
      if (r.parts.length !== segs.length) {
        /* A trailing :rest param swallows everything left over. */
        const last = r.parts[r.parts.length - 1];
        if (!(last && last.startsWith(':') && segs.length > r.parts.length)) continue;
      }
      const params = {};
      let ok = true;
      for (let i = 0; i < r.parts.length; i++) {
        const p = r.parts[i];
        if (p.startsWith(':')) {
          params[p.slice(1)] = i === r.parts.length - 1
            ? decodeURIComponent(segs.slice(i).join('/'))
            : decodeURIComponent(segs[i]);
        } else if (p !== segs[i]) { ok = false; break; }
      }
      if (ok) return { route: r, params };
    }
    return null;
  }

  /* The app scrolls inside #viewScroll, not the window: html and body are
     overflow:hidden so the three panes can size themselves. Anything reading
     window.scrollY or calling window.scrollTo here is a no-op. */
  const scroller = () => document.getElementById('viewScroll');

  const routeId = (path, query) => path + '?' +
    Object.keys(query || {}).sort().map(k => `${k}=${query[k]}`).join('&');

  async function resolve() {
    const { segs, query, path } = parse();
    const hit = match(segs);
    const token = ++currentToken;

    /* Re-resolving the SAME screen is a refresh, not a navigation, and must
       not throw away the reader's place. This happens more than it looks:
       adding an item saves, a save can merge, and a merge calls resolve().
       Without this, adding three things in a row from a long list means
       scrolling back down twice. */
    const el = scroller();
    const sameRoute = current && routeId(current.path, current.query) === routeId(path, query);
    const keepTop = sameRoute && el ? el.scrollTop : 0;

    const view = document.getElementById('view');
    highlightNav(segs[0] || '');
    /* The index tree carries the real navigation, and its selection is derived
       from the route — so it has to be re-marked here. Leaving it to the
       tree's own refresh meant the highlight only moved when the LIBRARY
       changed, so it sat on whatever screen you were on the last time you
       added something. */
    if (MT.tree && MT.tree.markRoute) MT.tree.markRoute();

    if (!hit) {
      view.innerHTML = MT.ui.emptyState({
        title: 'Nothing here',
        body: `No screen matches <span class="num">#${MT.util.escapeHtml(path)}</span>.`,
        actions: '<a class="btn" href="#/">Go home</a>',
      });
      return;
    }

    current = { path, params: hit.params, query };
    try {
      await hit.route.handler(hit.params, query, () => token === currentToken);
    } catch (e) {
      console.error('[router] view failed', e);
      /* An error boundary: one broken screen must not take the shell down. */
      view.innerHTML = MT.ui.errorBox(
        'This screen could not be displayed',
        (e && e.message) || String(e));
    }
    /* Restoring has to survive the content briefly collapsing: a handler that
       replaces #view empties the scroller, the browser clamps scrollTop to 0,
       and only then are rows painted back. Setting it once after the handler
       and once more on the next frame covers both orderings. */
    const back = scroller();
    if (back) {
      if (keepTop) {
        back.scrollTop = keepTop;
        requestAnimationFrame(() => {
          if (token === currentToken && back.scrollTop !== keepTop) back.scrollTop = keepTop;
        });
      } else {
        back.scrollTop = 0;
      }
    }
  }

  function highlightNav(section) {
    for (const a of document.querySelectorAll('[data-nav]')) {
      if (a.dataset.nav === section) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    }
  }

  function go(hash) {
    if (location.hash === hash) resolve();
    else location.hash = hash;
  }

  function start() {
    window.addEventListener('hashchange', () => {
      const { path } = parse();
      void path;
      resolve();
    });
    const el = scroller();
    if (el) {
      el.addEventListener('scroll', MT.util.debounce(() => {
        if (current) sessionStorage.setItem('scroll:' + current.path, String(el.scrollTop));
      }, 250), { passive: true });
    }
    if (!location.hash) location.hash = '#/';
    resolve();
  }

  return { on, go, start, resolve, parse, get current() { return current; } };
})();
