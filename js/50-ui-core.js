/* ══════════════════════════════════════════════════════════════════════════
   Shared UI: the six components every screen is built from, plus toasts,
   keyboard handling, and the add-to-library flow.

   There is exactly ONE implementation of each component. Views compose these
   and never hand-roll a poster or a date.
   ══════════════════════════════════════════════════════════════════════════ */

MT.ui = (function () {
  const esc = MT.util.escapeHtml;

  /* ── 1. Poster card ─────────────────────────────────────────────────── */
  function posterCard(item, opts) {
    opts = opts || {};
    const src = posterUrl(item, MT.IMG.poster.md);
    const rel = item.release || {};
    const status = item.user && item.user.status;
    const kindLabel = item.facets && item.facets.anime ? 'Anime'
                    : item.kind === 'tv' ? 'TV' : item.kind === 'game' ? 'Game' : 'Film';

    return `
      <a class="card" href="#/item/${encodeURIComponent(item.uid)}" data-uid="${esc(item.uid)}">
        <div class="card__art${src ? '' : ' card__art--empty'}">
          ${src ? `<img loading="lazy" src="${esc(src)}" alt="">`
                : esc(MT.util.truncate(item.title, 40))}
          <span class="card__kind">${kindLabel}</span>
          ${status && !opts.hideStatus ? `<span class="stamp stamp--${esc(status)}">${statusWord(status)}</span>` : ''}
        </div>
        <div class="card__title">${esc(item.title)}</div>
        <div class="card__sub">
          ${dateChip(rel, { compact: true })}
          ${opts.extra || ''}
        </div>
      </a>`;
  }

  function posterUrl(item, size) {
    const p = item.images && item.images.posterPath;
    if (!p) return null;
    /* RAWG hands back absolute URLs; TMDB hands back paths that must be
       prefixed at render time — sizes get retired, so a stored URL would rot. */
    return /^https?:/.test(p) ? p : MT.tmdb.img(p, size);
  }

  function statusWord(s) {
    return ({ want: 'Want', watching: 'Watching', watched: 'Seen', dropped: 'Dropped' })[s] || s;
  }

  /* ── 2. Result row ──────────────────────────────────────────────────── */
  function resultRow(item, opts) {
    opts = opts || {};
    const src = posterUrl(item, MT.IMG.poster.sm);
    const year = yearOf(item);
    const kindLabel = item.kind === 'tv' ? 'TV' : item.kind === 'game' ? 'Game' : 'Film';
    return `
      <div class="row" role="option" data-uid="${esc(item.uid)}" ${opts.selected ? 'aria-selected="true"' : ''}>
        ${src ? `<img class="row__art" loading="lazy" src="${esc(src)}" alt="">`
              : '<span class="row__art"></span>'}
        <div class="row__main">
          <div class="row__title">${esc(item.title)}</div>
          <div class="row__meta">
            <span>${kindLabel}</span>
            ${year ? `<span>${year}</span>` : ''}
            ${item.ratings && item.ratings.tmdb
              ? `<span>★ ${item.ratings.tmdb.score.toFixed(1)}</span>` : ''}
          </div>
        </div>
        <div class="row__act">
          ${opts.inLibrary
            ? `<span class="row__in">✓ ${statusWord(opts.inLibrary)}</span>`
            : `<button class="btn btn--sm" data-add="${esc(item.uid)}">Add</button>`}
        </div>
      </div>`;
  }

  function yearOf(item) {
    const p = MT.util.sortKeyToParts(item.release && item.release.sortKey);
    return p ? p.y : null;
  }

  /* ── 3. Date chip ────────────────────────────────────────────────────
     Precision is rendered honestly. A month-precision item never shows a day
     number anywhere — not here, not in the calendar, nowhere. */
  function dateChip(release, opts) {
    opts = opts || {};
    if (!release) return '';
    const prec = release.precision || 'unknown';
    const days = release.sortKey < MT.util.SK_UNKNOWN ? MT.util.daysUntil(release.sortKey) : null;

    let cls = 'datechip datechip--' + prec;
    if (days === 0) cls += ' datechip--today';
    else if (days != null && days > 0 && days <= 14) cls += ' datechip--soon';

    const text = release.display || 'No date';
    /* A countdown against a vague date would be a fabricated precision, so
       only day-precise items get one. */
    const showCount = !opts.compact && prec === 'day' && days != null && days > -30;

    return `<span class="${cls}" title="${esc(prec === 'day' ? text : prec + ' precision')}">${esc(text)}</span>`
      + (showCount ? ` <span class="countdown${days >= 0 && days <= 14 ? ' countdown--soon' : ''}">${esc(MT.util.relativeDays(days))}</span>` : '');
  }

  /* ── 4. Production-status pill ──────────────────────────────────────── */
  function statusPill(release) {
    if (!release || !release.status) return '';
    const s = release.status;
    if (s === 'released' || s === 'ended') return '';    // saying so is noise
    return `<span class="prodstatus prodstatus--${esc(s)}">${esc(MT.alerts.prettyStatus(s))}</span>`;
  }

  /* ── 5. Drift badge ─────────────────────────────────────────────────── */
  function driftBadge(release) {
    const h = release && release.history;
    if (!h || !h.length) return '';
    const last = h[h.length - 1];
    if (last.deltaDays == null) return '';
    const later = last.deltaDays > 0;
    const label = `${later ? 'Delayed' : 'Moved up'} ${Math.abs(last.deltaDays)}d`;
    const from = MT.util.sortKeyToParts(last.from.sortKey);
    const to = MT.util.sortKeyToParts(last.to.sortKey);
    const title = from && to
      ? `${MT.util.displayRelease(from, last.from.precision)} → ${MT.util.displayRelease(to, last.to.precision)}`
      : '';
    return `<span class="drift drift--${later ? 'later' : 'earlier'}" title="${esc(title)}">${esc(label)}</span>`;
  }

  /* ── 6. Rating tile ───────────────────────────────────────────────────
     Native units, never combined. A Tomatometer is the share of critics who
     were positive; a Metascore is a weighted quality average; they are not
     commensurable and averaging them yields a number that means nothing.

     Absence is rendered in two distinct ways, because they mean different
     things: a source that does not cover this medium at all is omitted
     entirely, while a source that covers it but has no score yet shows a
     muted dash. Collapsing the two makes missing data look like a bug. */
  function ratingTile(src, r, opts) {
    opts = opts || {};
    const meta = {
      imdb:       { label: 'IMDb',       fmt: v => v.toFixed(1), suffix: '/10' },
      tmdb:       { label: 'TMDB',       fmt: v => v.toFixed(1), suffix: '/10' },
      rt:         { label: 'Tomatometer', fmt: v => String(Math.round(v)), suffix: '%' },
      metacritic: { label: 'Metacritic', fmt: v => String(Math.round(v)), suffix: '/100' },
      anilist:    { label: 'AniList',    fmt: v => String(Math.round(v)), suffix: '%' },
      rawg:       { label: 'RAWG',       fmt: v => v.toFixed(1), suffix: '/5' },
      user:       { label: 'You',        fmt: v => v.toFixed(1), suffix: '/10' },
    }[src];
    if (!meta) return '';

    if (!r || r.score == null) {
      if (opts.pending) {
        return `<div class="rating rating--pending" data-src="${src}">
                  <span class="rating__src">${meta.label}</span>
                  <span class="rating__val">…</span></div>`;
      }
      return `<div class="rating rating--empty" data-src="${src}" title="No score from ${meta.label} yet">
                <span class="rating__src">${meta.label}</span>
                <span class="rating__val">—</span></div>`;
    }

    const inner = `
      <span class="rating__src">${meta.label}</span>
      <span class="rating__val">${esc(meta.fmt(r.score))}<small>${meta.suffix}</small></span>
      ${r.votes ? `<span class="rating__votes">${esc(MT.util.formatVotes(r.votes))} votes</span>` : ''}`;

    return r.url
      ? `<a class="rating" data-src="${src}" href="${esc(r.url)}" target="_blank" rel="noopener">${inner}</a>`
      : `<div class="rating" data-src="${src}">${inner}</div>`;
  }

  /* ── Shells ─────────────────────────────────────────────────────────── */

  function ruleHead(label, aside) {
    return `<div class="rulehead">
      <span class="rulehead__label">${esc(label)}</span>
      <span class="rulehead__rule"></span>
      ${aside ? `<span class="rulehead__aside">${aside}</span>` : ''}
    </div>`;
  }

  function emptyState(o) {
    return `<div class="empty">
      <h3>${esc(o.title)}</h3>
      <p>${o.body || ''}</p>
      ${o.actions || ''}
    </div>`;
  }

  function errorBox(title, body) {
    return `<div class="errorbox"><strong>${esc(title)}</strong>${esc(body)}</div>`;
  }

  function skeletonGrid(n) {
    let s = '<div class="grid">';
    for (let i = 0; i < (n || 12); i++) {
      s += '<div><div class="skel skel--poster"></div><div class="skel skel--line"></div></div>';
    }
    return s + '</div>';
  }

  /* ── Toasts ─────────────────────────────────────────────────────────── */
  function toast(message, opts) {
    opts = opts || {};
    const host = document.getElementById('toasts');
    const el = document.createElement('div');
    el.className = 'toast' + (opts.bad ? ' toast--bad' : '');
    el.innerHTML = `<span>${esc(message)}</span>`;
    if (opts.actionLabel) {
      const b = document.createElement('button');
      b.textContent = opts.actionLabel;
      b.onclick = () => { el.remove(); opts.onAction && opts.onAction(); };
      el.appendChild(b);
    }
    host.appendChild(el);
    setTimeout(() => el.remove(), opts.ms || (opts.actionLabel ? 7000 : 3200));
    return el;
  }

  function banner(message, opts) {
    opts = opts || {};
    const el = document.getElementById('banner');
    if (!el) return;
    el.hidden = false;
    el.innerHTML = `<span>${esc(message)}</span>`;
    if (opts.actionLabel) {
      const b = document.createElement('button');
      b.textContent = opts.actionLabel;
      b.onclick = () => { opts.onAction && opts.onAction(); el.hidden = true; };
      el.appendChild(b);
    } else {
      const b = document.createElement('button');
      b.textContent = 'Dismiss';
      b.onclick = () => { el.hidden = true; };
      el.appendChild(b);
    }
  }

  /* ── The add flow ─────────────────────────────────────────────────────
     Optimistic: a stub is written and the UI updates immediately, then the
     full detail fetch fills it in. "Three keystrokes to on-my-list" only holds
     if adding never waits on the network. */
  async function addItem(stub, opts) {
    opts = opts || {};
    const existingUid = await MT.repo.resolveUid(MT.repo.idKeysFor(stub));
    if (existingUid) {
      const existing = await MT.repo.getItem(existingUid);
      if (existing) {
        MT.ui.toast(`Already in your library as “${existing.user.status}”.`);
        return existing;
      }
    }

    const item = MT.normalize.withDefaults(stub, opts.status || 'want', opts.source || 'search');
    MT.sync.retier(item);
    await MT.repo.putItem(item);
    /* First observation establishes a baseline and emits nothing. */
    await MT.repo.putSnapshot(Object.assign({ baseline: 1 }, MT.alerts.snapshotOf(item)));

    toast(`Added “${MT.util.truncate(item.title, 40)}”`, {
      actionLabel: 'Undo',
      onAction: async () => { await MT.repo.deleteItem(item.uid); MT.router.resolve(); },
    });

    hydrate(item.uid).catch(e => console.warn('[ui] hydrate failed', e));
    return item;
  }

  /* Fill in a partial record with the full detail payload. */
  async function hydrate(uid) {
    const item = await MT.repo.getItem(uid);
    if (!item) return null;
    if (!item.meta.partial && Date.now() - item.meta.detailsFetchedAt < MT.TTL.details) return item;

    let fresh = null;
    if (item.kind === 'game') {
      if (!MT.config.hasKey('rawg') || !item.ids.rawg) return item;
      fresh = MT.normalize.fromRawg(await MT.rawg.game(item.ids.rawg));
    } else {
      if (!MT.config.hasKey('tmdb')) return item;
      fresh = MT.normalize.fromTmdb(await MT.tmdb.details(item.kind, item.ids.tmdb), item.kind);
    }
    const merged = MT.normalize.mergeItem(item, fresh);
    merged.meta.partial = 0;
    MT.sync.retier(merged);
    await MT.repo.putItem(merged);
    MT.repo.dfObserve(merged.uid, Object.keys(merged.rec.terms || {}));

    /* OMDb is best-effort and must never block: it patches in when it lands. */
    if (merged.ids.imdb && MT.config.hasKey('omdb')) {
      MT.omdb.byImdbId(merged.ids.imdb).then(async r => {
        if (!r) return;
        const cur = await MT.repo.getItem(uid);
        if (!cur) return;
        Object.assign(cur.ratings, r);
        await MT.repo.putItemQuiet(cur);
        MT.repo.emit('item:ratings', { uid });
      }).catch(() => {});
    }
    if (merged.facets && merged.facets.anime) {
      MT.anilist.enrichItem(merged).then(async changed => {
        if (!changed) return;
        await MT.repo.putItemQuiet(merged);
        MT.repo.emit('item:ratings', { uid });
      }).catch(() => {});
    }
    return merged;
  }

  async function setStatus(uid, status) {
    const item = await MT.repo.getItem(uid);
    if (!item) return null;
    const before = item.user.status;
    item.user.status = status;
    if (status === 'watching' && !item.user.startedAt) item.user.startedAt = Date.now();
    if (status === 'watched') {
      item.user.finishedAt = Date.now();
      MT.repo.addHistory(uid, 'finished');
    }
    MT.sync.retier(item);
    await MT.repo.putItem(item);
    toast(`Moved to ${statusWord(status)}`, {
      actionLabel: 'Undo',
      onAction: async () => {
        const it = await MT.repo.getItem(uid);
        if (it) { it.user.status = before; await MT.repo.putItem(it); MT.router.resolve(); }
      },
    });
    return item;
  }

  /* ── Keyboard ─────────────────────────────────────────────────────────
     "/" focuses search from anywhere. Deliberately not a full command palette
     — one shortcut people actually use beats twelve they don't. */
  function installKeyboard() {
    document.addEventListener('keydown', e => {
      const tag = (e.target.tagName || '').toLowerCase();
      const typing = tag === 'input' || tag === 'textarea' || e.target.isContentEditable;
      if (e.key === '/' && !typing) {
        e.preventDefault();
        const omni = document.getElementById('omni');
        omni.focus(); omni.select();
      }
      if (e.key === 'Escape' && tag === 'input') e.target.blur();
    });
  }

  function confirmDialog(message) {
    return window.confirm(message);
  }

  return {
    posterCard, resultRow, dateChip, statusPill, driftBadge, ratingTile,
    ruleHead, emptyState, errorBox, skeletonGrid, toast, banner,
    addItem, hydrate, setStatus, installKeyboard, confirmDialog,
    posterUrl, statusWord, yearOf, esc,
  };
})();
