/* ══════════════════════════════════════════════════════════════════════════
   Shared UI. One implementation of each component; views compose these and
   never hand-roll a poster, a date or a rating.
   ══════════════════════════════════════════════════════════════════════════ */

MT.ui = (function () {
  const esc = MT.util.escapeHtml;

  /* ══ THE DATE GRAMMAR ═══════════════════════════════════════════════════
     A date is a fixed 10-slot monospace field. A segment that is not stored is
     replaced by a hatched block exactly as wide as the digits it stands in
     for — which works because the placeholder characters are monospace too.

         2027-12-18   day known
         2026-12-▨▨   month known, day does not exist in the record
         2027-▨▨-▨▨   year only
         ▨▨▨▨-▨▨-▨▨   nothing announced

     hatch = the value cannot exist in the record
     dots  = the value exists upstream but we have not fetched it

     This is the app's core idea, and the reason it renders here and nowhere
     else: a month-precision title must never display a day, on any screen. */
  const HATCH = c => `<span class="hatch">${'▨'.repeat(c)}</span>`;

  function dateField(release, opts) {
    opts = opts || {};
    if (!release) return `<span class="date">${HATCH(4)}<span class="sep">-</span>${HATCH(2)}<span class="sep">-</span>${HATCH(2)}</span>`;
    const p = MT.util.sortKeyToParts(release.sortKey);
    const prec = release.precision || 'unknown';

    let y, m, d;
    if (!p || prec === 'tba' || prec === 'unknown') { y = HATCH(4); m = HATCH(2); d = HATCH(2); }
    else if (prec === 'year') { y = k(p.y); m = HATCH(2); d = HATCH(2); }
    else if (prec === 'quarter') { y = k(p.y); m = HATCH(2); d = HATCH(2); }
    else if (prec === 'month') { y = k(p.y); m = k(pad(p.m)); d = HATCH(2); }
    else { y = k(p.y); m = k(pad(p.m)); d = k(pad(p.d)); }

    const title = prec === 'quarter'
      ? `Q${MT.util.quarterOf(p.m)} ${p.y} — no month announced`
      : release.display || 'No date';

    return `<span class="date" title="${esc(title)}">${y}<span class="sep">-</span>${m}<span class="sep">-</span>${d}</span>`;
  }
  const k = v => `<span class="k">${v}</span>`;
  const pad = n => String(n).padStart(2, '0');

  /* Aquarium's waterline gauge: three segments, filled only for what is
     actually stored. Reads at a glance in a dense column where the mono field
     needs a beat of attention. */
  function waterline(release) {
    const prec = (release && release.precision) || 'unknown';
    const fills = { day: 3, month: 2, quarter: 2, year: 1, tba: 0, unknown: 0 }[prec] || 0;
    let s = '<span class="wl" aria-hidden="true">';
    for (let i = 0; i < 3; i++) s += `<i class="${i < fills ? 'f' : ''}"></i>`;
    return s + '</span>';
  }

  function precisionTag(release) {
    const prec = (release && release.precision) || 'unknown';
    const label = { day: 'Exact day', month: 'Month only', quarter: 'Quarter', year: 'Year only',
                    tba: 'TBA', unknown: 'No date' }[prec] || prec;
    return `<span class="prec ${esc(prec)}">${esc(label)}</span>`;
  }

  function dateCell(release, item) {
    const n = item ? nextAir(item) : null;
    /* A series shows both facts in one cell: when it started, and what is
       coming. Without the second half the column is just "2016" for a show
       returning next month, which is true and useless. */
    /* The label collapses to a coloured dot on a phone. Spelled out it costs
       ~50px of the release column, which comes straight out of the title —
       measured, the title fell from 102px to 53px at 320px, undoing the whole
       point of pinning the columns. The dot still separates returning from
       ended at a glance, and the words are a tap away in the inspector. */
    const chip = n
      ? `<span class="nextchip ${esc(n.state)}"><i></i><b>${esc(nextAirLabel(item))}</b></span>`
      : '';
    return `<span class="datecell">${waterline(release)}${dateField(release)}${chip}</span>`;
  }

  /* Human phrasing, which must also respect precision — "in 3 days" against a
     month-only date would be inventing information. */
  function whenText(release) {
    if (!release || release.sortKey >= MT.util.SK_UNKNOWN) return 'No date announced';
    const days = MT.util.daysUntil(release.sortKey);
    if (release.precision === 'day') {
      return `<em>${esc(release.display)}</em> · ${esc(MT.util.relativeDays(days))}`;
    }
    const months = Math.round(days / 30);
    const approx = days < 0 ? 'already out' : months <= 1 ? 'about a month away' : `about ${months} months away`;
    return `<em>${esc(release.display)}</em> · ${approx}, no day to count down to`;
  }

  function driftBadge(release) {
    const h = release && release.history;
    if (!h || !h.length) return '';
    const last = h[h.length - 1];
    if (last.deltaDays == null) return '';
    const later = last.deltaDays > 0;
    return `<span class="drift ${later ? 'later' : 'earlier'}">${later ? '→' : '←'} ${Math.abs(last.deltaDays)}d</span>`;
  }

  /* ══ POSTER ═════════════════════════════════════════════════════════════
     Real TMDB artwork when we have it. When we do not, a generated block
     built from a hash of the title, so a missing image is a deliberate
     composition rather than an empty hole. */
  function posterUrl(item, size) {
    const p = item && item.images && item.images.posterPath;
    if (!p) return null;
    return /^https?:/.test(p) ? p : MT.tmdb.img(p, size);
  }

  const HUES = [
    ['#3E6B78', '#16242A'], ['#6B4A6E', '#241A2E'], ['#4E7A6B', '#17251F'],
    ['#7A5A3E', '#2A1D14'], ['#455C86', '#171F30'], ['#7A3F49', '#2B161A'],
    ['#5D6B3E', '#1F2416'], ['#3F5F7A', '#16222B'],
  ];
  function hues(title) {
    const h = parseInt(MT.util.fnv1a(title || 'x').slice(0, 4), 36) || 0;
    return HUES[h % HUES.length];
  }

  function poster(item, opts) {
    opts = opts || {};
    const url = posterUrl(item, opts.size || MT.IMG.poster.md);
    const [a, b] = hues(item.title);
    const initial = (item.title || '?').trim()[0] || '?';
    const cls = 'poster' + (url ? '' : ' gen') + (opts.cls ? ' ' + opts.cls : '');
    return `<div class="${cls}" style="--a:${a};--b:${b}" data-i="${esc(initial)}">${
      url ? `<img loading="lazy" src="${esc(url)}" alt="">` : ''
    }</div>`;
  }

  function chipart(item) {
    const url = posterUrl(item, MT.IMG.poster.sm);
    const [a, b] = hues(item.title);
    return `<span class="chipart" style="--a:${a};--b:${b}">${
      url ? `<img loading="lazy" src="${esc(url)}" alt="">` : ''
    }</span>`;
  }

  /* ══ LABELS ═════════════════════════════════════════════════════════════ */
  function kindOf(item) {
    if (item.facets && item.facets.anime) return 'anime';
    return item.kind === 'tv' ? 'tv' : item.kind === 'game' ? 'game' : 'film';
  }
  const KIND_LABEL = { film: 'Film', tv: 'TV', game: 'Game', anime: 'Anime' };
  function kindTag(item) {
    const kd = kindOf(item);
    return `<span class="tag ${kd}">${KIND_LABEL[kd]}</span>`;
  }
  const STATUS_WORD = { want: 'Want', watching: 'Watching', watched: 'Finished', dropped: 'Dropped' };
  function statusCell(item) {
    const s = (item.user && item.user.status) || 'want';
    return `<span class="stat"><span class="dot c-${s} ${s === 'watching' ? 'fill' : ''}"></span>${STATUS_WORD[s]}</span>`;
  }

  /* ── The TV date pair ───────────────────────────────────────────────────
     `item.release` is when a series premiered. `tvExtra.next` is what happens
     next. Every view has to read them the same way or they drift apart, so
     both readings live here.

     `upcomingRelease` answers "when is this next relevant" — the premiere for
     a film or an unaired series, the next episode for one already running.
     Coming Up and the refresh tiers both need that, and both would otherwise
     file a returning show under the year it started. */
  const NEXT_WORD = {
    dated: 'Next', tba: 'Returning', ended: 'Ended',
    cancelled: 'Cancelled', unknown: 'No date',
  };

  function nextAir(item) {
    if (!item || item.kind !== 'tv') return null;
    const n = item.tvExtra && item.tvExtra.next;
    if (n) return n;
    /* Records normalised before the split, or still meta.partial. */
    const legacy = item.tvExtra && item.tvExtra.nextEpisode;
    if (legacy && legacy.airDate) {
      return { state: 'dated', release: null, season: legacy.season, episode: legacy.episode };
    }
    return { state: 'unknown', release: null };
  }

  function upcomingRelease(item) {
    const n = nextAir(item);
    if (n && n.state === 'dated' && n.release) return n.release;
    return item.release;
  }

  /* A compact reading for a table row: the date when there is one, the state
     word when there is not. */
  function nextAirLabel(item) {
    const n = nextAir(item);
    if (!n) return '';
    if (n.state === 'dated' && n.release) {
      const ep = n.season != null && n.episode != null ? ` S${n.season}E${n.episode}` : '';
      return shortWhen(n.release) + ep;
    }
    return NEXT_WORD[n.state] || '';
  }

  /* ══ TABLE + GRID ═══════════════════════════════════════════════════════ */
  /* `drop` marks a column the phone layout hides (see 05-responsive.css).
     Type is deliberately NOT one of them: stripped of it, a narrow row is a
     bare title with no clue whether it is a film, a season of television or a
     game — which is the first thing you want when scanning a mixed library.
     It costs one short tag, and as its own column the kinds line up vertically
     and can be read down the page as a stripe. */
  const COLUMNS = [
    { key: 'title', label: 'Title' },
    { key: 'type', label: 'Type' },
    { key: 'status', label: 'Status', drop: true },
    { key: 'release', label: 'Release' },
    { key: 'progress', label: 'Progress', drop: true },
    { key: 'rating', label: 'Yours', num: true },
    { key: 'added', label: 'Added', num: true, drop: true },
  ];

  function table(items, selectedUid) {
    if (!items.length) return '';
    return `<div class="tblwrap"><table>
      <thead><tr>${COLUMNS.map(c =>
        `<th data-col="${c.key}"${c.num ? ' class="num"' : ''}${c.drop ? ' data-drop' : ''}>${c.label}</th>`).join('')}</tr></thead>
      <tbody>${items.map(it => tableRow(it, it.uid === selectedUid)).join('')}</tbody>
    </table></div>`;
  }

  function tableRow(item, selected) {
    const u = item.user || {};
    const added = u.addedAt ? new Date(u.addedAt) : null;
    return `<tr data-uid="${esc(item.uid)}"${selected ? ' class="is-sel"' : ''}>
      <td data-col="title"><span class="title-cell">${chipart(item)}<span class="t">${esc(item.title)}</span>${driftBadge(item.release)}</span>${progressBar(item)}</td>
      <td data-col="type">${kindTag(item)}</td>
      <td data-col="status" data-drop>${statusCell(item)}</td>
      <td data-col="release">${dateCell(item.release, item)}</td>
      <td data-col="progress" data-drop class="muted">${esc(progressText(item))}</td>
      <td data-col="rating" class="num mono">${u.rating != null ? esc(u.rating) + '<span class="faint">/10</span>' : '<span class="faint">·&nbsp;·</span>'}</td>
      <td data-col="added" data-drop class="num mono faint">${added ? esc(added.toISOString().slice(0, 10)) : ''}</td>
    </tr>`;
  }

  /* ══ PROGRESS ═══════════════════════════════════════════════════════════
     How far into a thing you are. One optional shape on user.progress, read
     according to item.kind rather than split into per-kind records — a merge
     between two devices then has one field to reconcile instead of three, and
     an item that changes kind (a film that turns out to be a miniseries)
     does not strand its data.

       user.progress = { minutes, season, episode, percent, updatedAt }

     Every field is optional and only the ones meaningful for the kind are ever
     written. It lives under `user`, which leanForSync does not drop, so it
     syncs like the rating and the notes do.

     This replaced a column that was showing something else entirely: the TV
     branch returned tvExtra.nextEpisode — TMDB's next AIRING episode, upstream
     broadcast state identical for every user — the film branch returned total
     runtime, and the only branch that read user state was dead because nothing
     in the app ever wrote user.progress. */

  function progressOf(item) {
    const p = item && item.user && item.user.progress;
    return p && typeof p === 'object' ? p : null;
  }

  /* 0..1, or null when there is no denominator to measure against. A film with
     no runtime and a show with no episode count are genuinely unmeasurable —
     they get a position, not a fraction. */
  function progressFraction(item) {
    const p = progressOf(item);
    if (!p) return (item.user && item.user.status === 'watched') ? 1 : null;
    if (item.kind === 'game') {
      return p.percent != null ? MT.util.clamp(p.percent, 0, 100) / 100 : null;
    }
    if (item.kind === 'tv') {
      const total = item.tvExtra && item.tvExtra.episodeCount;
      if (!total || p.episode == null) return null;
      return MT.util.clamp(p.episode / total, 0, 1);
    }
    if (p.minutes == null || !item.runtimeMin) return null;
    return MT.util.clamp(p.minutes / item.runtimeMin, 0, 1);
  }

  function progressText(item) {
    const u = item.user || {};
    const p = progressOf(item);
    if (p) {
      if (item.kind === 'tv' && p.episode != null) {
        return `S${p.season || 1} E${p.episode}`;
      }
      if (item.kind === 'game' && p.percent != null) return `${Math.round(p.percent)}%`;
      if (p.minutes != null) {
        const f = progressFraction(item);
        return f != null ? `${Math.round(f * 100)}%` : `${MT.util.runtimeStr(p.minutes)} in`;
      }
    }
    if (u.status === 'watched') return 'Finished';
    return '—';
  }

  /* A hairline along the bottom of the row. Deliberately not another column:
     the phone layout has no width to spare, and this is legible at 320px. */
  function progressBar(item) {
    const f = progressFraction(item);
    if (f == null || f <= 0) return '';
    return `<span class="prg" aria-hidden="true"><i style="width:${(f * 100).toFixed(1)}%"></i></span>`;
  }

  /* Clamped on the way in, so nothing downstream has to defend against
     episode 0, 150%, or a position past the end of the film. */
  function setProgress(uid, patch) {
    return MT.repo.getItem(uid).then(async cur => {
      if (!cur) return null;
      const p = Object.assign({}, progressOf(cur));
      if (patch.minutes !== undefined) {
        p.minutes = patch.minutes == null ? undefined
          : Math.round(MT.util.clamp(patch.minutes, 0, cur.runtimeMin || 100000));
      }
      if (patch.percent !== undefined) {
        p.percent = patch.percent == null ? undefined
          : Math.round(MT.util.clamp(patch.percent, 0, 100));
      }
      if (patch.season !== undefined) {
        p.season = patch.season == null ? undefined : Math.max(1, Math.round(patch.season));
      }
      if (patch.episode !== undefined) {
        p.episode = patch.episode == null ? undefined : Math.max(0, Math.round(patch.episode));
      }
      for (const k of Object.keys(p)) if (p[k] === undefined) delete p[k];

      const empty = !Object.keys(p).filter(k => k !== 'updatedAt').length;
      cur.user.progress = empty ? null : Object.assign(p, { updatedAt: Date.now() });

      /* Recording progress on something still filed as "want" is a statement
         that you have started it. Never the reverse: finishing is a decision,
         not something inferred from a slider reaching the end. */
      if (!empty && cur.user.status === 'want') cur.user.status = 'watching';

      await MT.repo.putItem(cur);
      return cur;
    });
  }

  function grid(items, selectedUid) {
    return `<div class="grid">${items.map(it => `
      <div class="card${it.uid === selectedUid ? ' is-sel' : ''}" data-uid="${esc(it.uid)}">
        ${poster(it)}
        <div class="ct">${esc(it.title)}</div>
        <div class="cs">${waterline(it.release)}<span class="mono">${esc(shortWhen(it.release))}</span></div>
      </div>`).join('')}</div>`;
  }

  function shortWhen(release) {
    if (!release || release.sortKey >= MT.util.SK_UNKNOWN) return 'TBA';
    const p = MT.util.sortKeyToParts(release.sortKey);
    if (release.precision === 'day') return release.display;
    if (release.precision === 'month') return `${MT.util.MONTHS_ABBR[p.m - 1]} ${p.y}`;
    return String(p.y);
  }

  /* ══ FEEDBACK ═══════════════════════════════════════════════════════════ */
  function emptyState(o) {
    return `<div class="empty"><h3>${esc(o.title)}</h3><p>${o.body || ''}</p>${o.actions || ''}</div>`;
  }
  function errorBox(title, body) {
    return `<div class="errorbox"><strong>${esc(title)}</strong>${esc(body)}</div>`;
  }
  function skeletonGrid(n) {
    let s = '<div class="grid">';
    for (let i = 0; i < (n || 12); i++) s += '<div><div class="skel skel--poster"></div><div class="skel skel--line"></div></div>';
    return s + '</div>';
  }
  function groupHead(label, count) {
    return `<div class="group-h">${esc(label)}${count != null ? ` <span class="count">${count}</span>` : ''}</div>`;
  }

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
    const b = document.createElement('button');
    b.textContent = opts.actionLabel || 'Dismiss';
    b.onclick = () => { if (opts.onAction) opts.onAction(); el.hidden = true; };
    el.appendChild(b);
  }

  function crumb(parts) {
    const el = document.getElementById('crumb');
    if (!el) return;
    el.innerHTML = parts.map((p, i) =>
      i === parts.length - 1 ? `<b>${esc(p)}</b>` : `${esc(p)}<s>/</s>`).join(' ');
  }

  function paneActions(html) {
    const el = document.getElementById('paneActions');
    if (el) el.innerHTML = html || '';
  }

  /* ══ ADD / MUTATE ═══════════════════════════════════════════════════════ */
  async function addItem(stub, opts) {
    opts = opts || {};
    const existingUid = await MT.repo.resolveUid(MT.repo.idKeysFor(stub));
    if (existingUid) {
      const existing = await MT.repo.getItem(existingUid);
      if (existing) { toast(`Already in your index as “${STATUS_WORD[existing.user.status]}”.`); return existing; }
    }
    const item = MT.normalize.withDefaults(stub, opts.status || 'want', opts.source || 'search');
    MT.sync.retier(item);
    await MT.repo.putItem(item);
    /* First observation is a baseline and emits nothing. */
    await MT.repo.putSnapshot(Object.assign({ baseline: 1 }, MT.alerts.snapshotOf(item)));

    toast(`Added “${MT.util.truncate(item.title, 40)}”`, {
      actionLabel: 'Undo',
      onAction: async () => { await MT.repo.deleteItem(item.uid); MT.router.resolve(); },
    });
    /* Deliberately without ratings — adding ten titles should not spend ten
       OMDb lookups against a 1,000/day allowance for scores nobody asked for. */
    hydrate(item.uid, { ratings: false }).catch(e => console.warn('[ui] hydrate failed', e));
    return item;
  }

  async function hydrate(uid, opts) {
    opts = opts || {};
    const wantRatings = opts.ratings !== false;
    const item = await MT.repo.getItem(uid);
    if (!item) return null;
    if (!item.meta.partial && Date.now() - item.meta.detailsFetchedAt < MT.TTL.details) {
      if (wantRatings) enrichRatings(item);
      return item;
    }

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
    if (wantRatings) enrichRatings(merged);
    return merged;
  }

  /* The scarce lookups, fired only when something is on screen. Both are
     best-effort and never block a render. */
  function enrichRatings(item) {
    const uid = item.uid;
    if (item.ids.imdb && MT.config.hasKey('omdb')) {
      const age = Date.now() - ((item.ratings && item.ratings.imdb && item.ratings.imdb.fetchedAt) || 0);
      if (age > MT.TTL.omdb) {
        MT.omdb.byImdbId(item.ids.imdb).then(async r => {
          if (!r) return;
          const cur = await MT.repo.getItem(uid);
          if (!cur) return;
          Object.assign(cur.ratings, r);
          await MT.repo.putItemQuiet(cur);
          MT.repo.emit('item:ratings', { uid });
        }).catch(() => {});
      }
    }
    if (item.facets && item.facets.anime) {
      MT.anilist.enrichItem(item).then(async changed => {
        if (!changed) return;
        const cur = await MT.repo.getItem(uid);
        if (cur) { Object.assign(cur, item); await MT.repo.putItemQuiet(cur); }
        MT.repo.emit('item:ratings', { uid });
      }).catch(() => {});
    }
  }

  async function setStatus(uid, status) {
    const item = await MT.repo.getItem(uid);
    if (!item) return null;
    const before = item.user.status;
    item.user.status = status;
    if (status === 'watching' && !item.user.startedAt) item.user.startedAt = Date.now();
    if (status === 'watched') { item.user.finishedAt = Date.now(); MT.repo.addHistory(uid, 'finished'); }
    MT.sync.retier(item);
    await MT.repo.putItem(item);
    toast(`Moved to ${STATUS_WORD[status]}`, {
      actionLabel: 'Undo',
      onAction: async () => {
        const it = await MT.repo.getItem(uid);
        if (it) { it.user.status = before; await MT.repo.putItem(it); MT.router.resolve(); }
      },
    });
    return item;
  }

  const confirmDialog = m => window.confirm(m);

  return {
    esc, dateField, waterline, precisionTag, dateCell, whenText, driftBadge,
    poster, posterUrl, chipart, hues, kindOf, kindTag, statusCell, shortWhen,
    nextAir, upcomingRelease, nextAirLabel, NEXT_WORD,
    progressText, progressBar, progressFraction, progressOf, setProgress,
    table, tableRow, grid, COLUMNS,
    emptyState, errorBox, skeletonGrid, groupHead, toast, banner, crumb, paneActions,
    addItem, hydrate, enrichRatings, setStatus, confirmDialog,
    STATUS_WORD, KIND_LABEL,
  };
})();
