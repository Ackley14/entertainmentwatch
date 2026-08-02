/* ══════════════════════════════════════════════════════════════════════════
   The trailer player.

   A YouTube embed in a card sized to 80% of the viewport, with YouTube's own
   controls and a working fullscreen button.

   Four things are deliberate:

   1 · The iframe is created on open and DESTROYED on close. Leaving it in the
       DOM with `display:none` keeps the video playing — audio included — which
       is the classic version of this bug. Clearing src is not enough either;
       the element goes.

   2 · youtube-nocookie.com, and no `autoplay` parameter beyond the one click
       the user already made. The privacy-enhanced host does not set tracking
       cookies until playback starts.

   3 · No backdrop-filter. The inspector sheet is the app's ONE blurred surface
       and that is asserted by the design tests; a second blurred layer over a
       playing video is also the most reliable way to make a phone stutter.

   4 · `allow="fullscreen"` AND `allowfullscreen` — the permissions-policy
       attribute is what modern Chrome honours, the bare attribute is what
       older Safari needs, and without both the fullscreen button is present
       but does nothing.
   ══════════════════════════════════════════════════════════════════════════ */

MT.player = (function () {
  const esc = MT.util.escapeHtml;
  let host = null;
  let lastFocus = null;

  function el() {
    if (host) return host;
    host = document.createElement('div');
    host.className = 'player';
    host.id = 'player';
    host.setAttribute('role', 'dialog');
    host.setAttribute('aria-modal', 'true');
    host.hidden = true;
    document.body.appendChild(host);

    host.addEventListener('click', e => {
      /* The card swallows its own clicks, so anything reaching the backdrop is
         a click outside it. */
      if (e.target === host || e.target.closest('[data-player-close]')) close();
    });
    return host;
  }

  function open(key, title) {
    if (!key) return;
    const h = el();
    lastFocus = document.activeElement;

    const src = `https://www.youtube-nocookie.com/embed/${encodeURIComponent(key)}`
      + '?autoplay=1&rel=0&modestbranding=1&playsinline=1';

    h.innerHTML = `
      <div class="player-card" role="document">
        <div class="player-bar">
          <div class="player-title">${esc(title || 'Trailer')}</div>
          <a class="player-out" href="https://www.youtube.com/watch?v=${encodeURIComponent(key)}"
             target="_blank" rel="noopener" title="Open on YouTube">YouTube ↗</a>
          <button class="icobtn" type="button" data-player-close aria-label="Close trailer">
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor"
                 stroke-width="2" aria-hidden="true"><path d="M6 6l12 12M18 6L6 18"/></svg>
          </button>
        </div>
        <div class="player-frame">
          <iframe src="${esc(src)}" title="${esc(title || 'Trailer')}"
                  frameborder="0" allowfullscreen
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; fullscreen"
                  referrerpolicy="strict-origin-when-cross-origin"></iframe>
        </div>
      </div>`;

    h.hidden = false;
    document.documentElement.classList.add('has-player');
    const btn = h.querySelector('[data-player-close]');
    if (btn) btn.focus();
  }

  function close() {
    if (!host || host.hidden) return;
    /* Emptying the container removes the iframe, which is the only reliable
       way to stop playback — a hidden iframe keeps playing audio. */
    host.innerHTML = '';
    host.hidden = true;
    document.documentElement.classList.remove('has-player');
    if (lastFocus && lastFocus.focus) lastFocus.focus();
    lastFocus = null;
  }

  const isOpen = () => !!host && !host.hidden;

  /* Capture phase, so the trailer closes before the inspector does — otherwise
     one Escape would dismiss both and the pane would vanish behind the video. */
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape' && isOpen()) {
      e.stopPropagation();
      close();
    }
  }, true);

  return { open, close, isOpen };
})();
