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

  async function resolve() {
    const { segs, query, path } = parse();
    const hit = match(segs);
    const token = ++currentToken;

    const view = document.getElementById('view');
    highlightNav(segs[0] || '');

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
    /* Preserve scroll on back/forward, reset it on a genuinely new screen. */
    const key = 'scroll:' + path;
    const saved = sessionStorage.getItem(key);
    if (saved && history.state && history.state.restore) window.scrollTo(0, +saved);
    else window.scrollTo(0, 0);
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
    window.addEventListener('scroll', MT.util.debounce(() => {
      if (current) sessionStorage.setItem('scroll:' + current.path, String(window.scrollY));
    }, 250), { passive: true });
    if (!location.hash) location.hash = '#/';
    resolve();
  }

  return { on, go, start, resolve, parse, get current() { return current; } };
})();
