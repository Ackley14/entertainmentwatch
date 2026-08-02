/* ══════════════════════════════════════════════════════════════════════════
   Pane 3 — the inspector.

   Selecting anything anywhere fills this pane. It is the app's only blurred
   surface: the sheet frosts over a wash taken from the selected title's own
   colour, which is what makes the dark theme read as depth rather than as a
   flat dark palette. Everything else in the app is opaque or plainly
   translucent, because a blur behind every row is the first thing to stutter.

   Below 1180px it detaches into a right-hand drawer.
   ══════════════════════════════════════════════════════════════════════════ */

MT.inspector = (function () {
  const esc = MT.util.escapeHtml;
  let currentUid = null;

  const el = () => document.getElementById('inspector');

  async function show(uid, opts) {
    opts = opts || {};
    currentUid = uid;
    const host = el();
    let item = await MT.repo.getItem(uid);

    if (!item) {
      /* Not in the index — a recommendation or a shared link. Fetch read-only
         so the pane still works, and offer to add. */
      host.innerHTML = shell(loadingBody());
      try { item = await fetchTransient(uid); }
      catch (e) { host.innerHTML = shell(MT.ui.errorBox('Could not load this title', e.message || String(e))); return; }
      if (!item) { host.innerHTML = shell(MT.ui.emptyState({ title: 'Not found', body: '' })); return; }
      item._transient = true;
    }

    paint(item);
    openDrawerIfNarrow();

    if (!item._transient) {
      /* This is the one place ratings are requested — the user is looking at
         it, which is what the OMDb allowance is for. */
      MT.ui.hydrate(uid, { ratings: true }).then(fresh => {
        if (fresh && currentUid === uid) MT.repo.getItem(uid).then(cur => cur && paint(cur));
      }).catch(() => {});
    }
    if (!opts.silent) markSelected(uid);
  }

  async function fetchTransient(uid) {
    const { kind, source, id } = MT.normalize.parseUid(uid);
    if (source === 'tmdb') return MT.normalize.withDefaults(MT.normalize.fromTmdb(await MT.tmdb.details(kind, id), kind), 'want', 'link');
    if (source === 'rawg') return MT.normalize.withDefaults(MT.normalize.fromRawg(await MT.rawg.game(id)), 'want', 'link');
    return null;
  }

  function shell(inner, item) {
    const [a, b] = item ? MT.ui.hues(item.title) : ['#2a3a42', '#0e1519'];
    return `
      <button class="insp-close" id="inspClose" aria-label="Close">
        <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 6l12 12M18 6L6 18"/></svg>
      </button>
      <div class="wash" style="--a:${a};--b:${b}"></div>
      <div class="sheet">${inner}</div>`;
  }

  const loadingBody = () => `<div class="skel insp-poster"></div><div class="skel skel--line" style="width:70%;height:20px;margin-top:14px"></div><div class="skel skel--line"></div>`;

  function empty() {
    el().innerHTML = shell(`
      <div class="insp-poster" style="background:transparent;box-shadow:none"></div>
      <div style="padding-top:26px">
        ${MT.ui.emptyState({
          title: 'Nothing selected',
          body: 'Pick a title from the list and everything known about it appears here.',
        })}
      </div>`);
    currentUid = null;
  }

  function paint(item) {
    const host = el();
    const r = item.ratings || {};
    const rel = item.release || {};
    const u = item.user || {};
    const kd = MT.ui.kindOf(item);
    const isTv = item.kind === 'tv';
    const dir = (item.people || []).filter(p => p.role === 'director' || p.role === 'creator').slice(0, 2);
    const cast = (item.people || []).filter(p => p.role === 'cast').slice(0, 4);

    const body = `
      ${MT.ui.poster(item, { cls: 'insp-poster', size: MT.IMG.poster.md })}
      <div class="itype">${MT.ui.kindTag(item)}${MT.ui.precisionTag(rel)}${MT.ui.driftBadge(rel)}</div>
      <div class="ititle">${esc(item.title)}</div>
      <div class="isub">
        ${MT.ui.dateField(rel)}
        ${item.runtimeMin ? `<span>· ${esc(MT.util.runtimeStr(item.runtimeMin))}</span>` : ''}
        ${cert(item) ? `<span>· ${esc(cert(item))}</span>` : ''}
      </div>

      ${item._transient ? `<div class="blk"><button class="btn btn--primary" data-act="add">Add to index</button></div>` : `
      <div class="blk">
        <div class="blk-h">Status</div>
        <div class="seg" role="group">
          ${['want', 'watching', 'watched', 'dropped'].map(s =>
            `<button type="button" data-status="${s}" aria-pressed="${u.status === s}">${MT.ui.STATUS_WORD[s]}</button>`).join('')}
        </div>
      </div>`}

      <div class="blk">
        <div class="blk-h">Ratings <span class="why">native units, never averaged</span></div>
        <div class="ratings">${ratingCells(item, r, isTv, kd)}</div>
      </div>

      ${item._transient ? '' : `
      <div class="blk">
        <div class="blk-h">Yours</div>
        <div class="mine">
          <span class="ticks" id="rateTicks">${
            Array.from({ length: 10 }, (_, i) =>
              `<i class="${u.rating >= i + 1 ? 'on' : ''}" data-rate="${i + 1}" title="${i + 1}/10"></i>`).join('')
          }</span>
          <span class="myscore">${u.rating != null ? `${u.rating}<s>/10</s>` : '<s>unrated</s>'}</span>
        </div>
        <div style="margin-top:var(--mt-space-4)">
          <textarea class="notecard" id="inspNotes" placeholder="Why you want to see it, who recommended it…">${esc(u.notes || '')}</textarea>
        </div>
      </div>`}

      <div class="blk">
        <div class="blk-h">Release</div>
        <dl class="kv">
          <dt>Status</dt><dd>${esc(MT.alerts.prettyStatus(rel.status))}</dd>
          <dt>Date</dt><dd>${MT.ui.dateField(rel)}</dd>
          <dt>Precision</dt><dd>${esc(rel.precision)}${rel.inferred ? ' <span class="faint">(inferred)</span>' : ''}</dd>
          ${rel.type ? `<dt>Channel</dt><dd>${esc(MT.alerts.prettyType(rel.type))}</dd>` : ''}
          ${item.tvExtra && item.tvExtra.nextEpisode
            ? `<dt>Next</dt><dd>S${item.tvExtra.nextEpisode.season} E${item.tvExtra.nextEpisode.episode}</dd>` : ''}
          ${item.tvExtra ? `<dt>Seasons</dt><dd>${item.tvExtra.seasonCount} · ${item.tvExtra.episodeCount} eps</dd>` : ''}
          ${item.gameExtra && item.gameExtra.playtimeHours ? `<dt>Typical</dt><dd>${item.gameExtra.playtimeHours}h</dd>` : ''}
        </dl>
        ${driftHistory(rel)}
      </div>

      ${(dir.length || cast.length) ? `
      <div class="blk">
        <div class="blk-h">${item.kind === 'game' ? 'Made by' : 'Credits'}</div>
        <dl class="kv">
          ${dir.length ? `<dt>${isTv ? 'Created by' : 'Director'}</dt><dd>${dir.map(p => esc(p.name)).join(', ')}</dd>` : ''}
          ${cast.length ? `<dt>Cast</dt><dd>${cast.map(p => esc(p.name)).join(', ')}</dd>` : ''}
        </dl>
      </div>` : ''}

      ${providers(item)}

      <div class="blk" id="mltBlk">
        <div class="blk-h">If you like this</div>
        <div id="mltBody"></div>
      </div>

      <div class="blk">
        <div class="blk-h">Elsewhere</div>
        <dl class="kv">${links(item)}</dl>
      </div>

      ${item._transient ? '' : `
      <div class="blk">
        <button class="btn btn--ghost btn--danger" data-act="remove">Remove from index</button>
      </div>`}
    `;

    host.innerHTML = shell(body, item);
    wire(item);
    loadMoreLikeThis(item);
  }

  function cert(item) {
    const region = MT.config.get('region') || 'US';
    return (item.certification || {})[region] || '';
  }

  /* Structural absence and situational absence are different facts and must
     look different: a source that does not cover this medium at all gets a
     hatched void, a source that covers it but has no score yet gets a dash. */
  function ratingCells(item, r, isTv, kd) {
    const cells = [];
    /* IMDb, Rotten Tomatoes and Metacritic all arrive through OMDb, so if that
       key is missing or rejected the honest answer is "not configured" rather
       than a dash implying the score simply does not exist. */
    const omdbDown = !MT.config.hasKey('omdb') ? 'No OMDb key — add one in Settings'
                   : MT.omdb.keyRejected() ? 'OMDb rejected the key — check Settings'
                   : null;

    const add = (key, label, val, scale, suffix, url, absent, pendingNote) => {
      if (absent) {
        cells.push(`<div class="src na"><div class="sn">${label}</div><span class="void"></span>
          <div class="note">${esc(absent)}</div></div>`);
        return;
      }
      if (!val || val.score == null) {
        cells.push(`<div class="src"><div class="sn">${label}</div>
          <div class="sv"><b class="faint">—</b></div>
          <div class="note">${esc(pendingNote || 'No score yet')}</div></div>`);
        return;
      }
      const pct = Math.max(0, Math.min(100, (val.score / scale) * 100));
      const inner = `<div class="sn">${label}</div>
        <div class="sv"><b>${esc(fmt(val.score, scale))}</b><i>${suffix}</i></div>
        <div class="meter"><i style="width:${pct.toFixed(0)}%"></i></div>
        ${val.votes ? `<div class="note">${esc(MT.util.formatVotes(val.votes))} votes</div>` : ''}`;
      cells.push(url ? `<a class="src" href="${esc(url)}" target="_blank" rel="noopener">${inner}</a>`
                     : `<div class="src">${inner}</div>`);
    };

    if (kd === 'game') {
      add('rawg', 'RAWG', r.rawg, 5, '/5', r.rawg && r.rawg.url);
      add('mc', 'Metacritic', r.metacritic, 100, '/100', r.metacritic && r.metacritic.url);
    } else {
      add('imdb', 'IMDb', r.imdb, 10, '/10', r.imdb && r.imdb.url, null, omdbDown);
      add('tmdb', 'TMDB', r.tmdb, 10, '/10', r.tmdb && r.tmdb.url);
      /* OMDb has effectively no RT or Metacritic coverage for television, so
         for TV these are structurally absent rather than merely pending. */
      add('rt', 'Rotten Tomatoes', r.rottenTomatoes, 100, '%', null,
          isTv ? 'Not rated for television' : null, omdbDown);
      add('mc', 'Metacritic', r.metacritic, 100, '/100', null,
          isTv ? 'Not rated for television' : null, omdbDown);
      if (item.facets && item.facets.anime) add('al', 'AniList', r.anilist, 100, '%', r.anilist && r.anilist.url);
    }
    return cells.join('');
  }
  const fmt = (v, scale) => scale === 10 ? v.toFixed(1) : String(Math.round(v));

  function driftHistory(rel) {
    const h = (rel.history || []).slice(-3).reverse();
    if (!h.length) return '';
    return `<div style="margin-top:var(--mt-space-4)">
      <div class="blk-h" style="margin-bottom:6px">Date history</div>
      ${h.map(x => `<div class="diff">
        ${MT.ui.dateField({ sortKey: x.from.sortKey, precision: x.from.precision })}
        <span class="faint">→</span>
        ${MT.ui.dateField({ sortKey: x.to.sortKey, precision: x.to.precision })}
        <span class="faint mono" style="font-size:var(--mt-fs-micro)">${esc(MT.util.timeAgo(x.observedAt))}</span>
      </div>`).join('')}
    </div>`;
  }

  /* JustWatch must be credited inline, where its data appears — that is what
     their terms require, and it is an access-revocation condition. */
  function providers(item) {
    const p = item.providers;
    if (!p) return '';
    const mine = new Set(MT.config.get('myProviders') || []);
    const all = [].concat(p.flatrate || [], p.free || [], p.ads || []);
    if (!all.length) return '';
    return `<div class="blk">
      <div class="blk-h">Where to watch <span class="why">${esc(p.region)}</span></div>
      <div class="providers">${all.map(x =>
        `<img class="provider${mine.has(x.id) ? ' mine' : ''}" loading="lazy"
              src="${esc(MT.tmdb.img(x.logoPath, MT.IMG.logo.sm))}" alt="${esc(x.name)}" title="${esc(x.name)}">`).join('')}</div>
      <div class="justwatch">Data by <a href="${esc(p.link || 'https://www.justwatch.com/')}" target="_blank" rel="noopener">JustWatch</a></div>
    </div>`;
  }

  function links(item) {
    const L = item.links || {};
    const rows = [
      ['IMDb', L.imdb, item.ids.imdb], ['TMDB', L.tmdb, item.ids.tmdb],
      ['Letterboxd', L.letterboxd, null], ['AniList', L.anilist, item.ids.anilist],
      ['RAWG', L.rawg, item.ids.rawg], ['Steam', L.steam, item.ids.steam],
    ].filter(x => x[1]);
    if (!rows.length) return '<dt>—</dt><dd></dd>';
    return rows.map(([label, href, id]) =>
      `<dt>${esc(label)}</dt><dd><a href="${esc(href)}" target="_blank" rel="noopener"
        style="text-decoration:underline">${id ? esc(id) : 'open'} ↗</a></dd>`).join('');
  }

  async function loadMoreLikeThis(item) {
    const body = document.getElementById('mltBody');
    if (!body) return;
    const drop = () => { const b = document.getElementById('mltBlk'); if (b) b.remove(); };
    if (item.kind === 'game' || !MT.config.hasKey('tmdb')) { drop(); return; }
    try {
      /* Zero network: candidate summaries were captured when this item's
         details were fetched. */
      const recs = await MT.rec.moreLikeThis(item, { limit: 4 });
      if (!recs.length) { drop(); return; }
      body.innerHTML = `<div class="strip">${recs.map(x => `
        <div data-goto="${esc(x.uid)}" style="cursor:pointer">
          ${MT.ui.poster(x.item, { size: MT.IMG.poster.sm })}
          <div class="st">${esc(x.item.title)}</div>
        </div>`).join('')}</div>`;
    } catch (_) { drop(); }
  }

  function wire(item) {
    const host = el();
    const close = document.getElementById('inspClose');
    if (close) close.onclick = closeDrawer;

    host.onclick = async e => {
      const st = e.target.closest('[data-status]');
      const rate = e.target.closest('[data-rate]');
      const act = e.target.closest('[data-act]');
      const goto = e.target.closest('[data-goto]');

      if (st) { await MT.ui.setStatus(item.uid, st.dataset.status); show(item.uid); MT.router.resolve(); }
      if (rate) {
        const n = +rate.dataset.rate;
        const cur = await MT.repo.getItem(item.uid);
        if (!cur) return;
        if (cur.user.rating === n) delete cur.user.rating; else cur.user.rating = n;
        await MT.repo.putItem(cur);
        MT.repo.addHistory(item.uid, 'rated', cur.user.rating || null);
        show(item.uid);
      }
      if (act && act.dataset.act === 'add') {
        delete item._transient;
        await MT.ui.addItem(item, { source: 'link' });
        show(item.uid);
        MT.router.resolve();
      }
      if (act && act.dataset.act === 'remove') {
        if (!MT.ui.confirmDialog(`Remove “${item.title}” from your index?`)) return;
        await MT.repo.deleteItem(item.uid);
        MT.ui.toast('Removed');
        empty();
        MT.router.resolve();
      }
      if (goto) show(goto.dataset.goto);
    };

    const notes = document.getElementById('inspNotes');
    if (notes) {
      const save = MT.util.debounce(async () => {
        const cur = await MT.repo.getItem(item.uid);
        if (!cur) return;
        cur.user.notes = notes.value;
        await MT.repo.putItem(cur);
      }, 500);
      notes.addEventListener('input', save);
    }
  }

  function markSelected(uid) {
    for (const el2 of document.querySelectorAll('#view [data-uid]')) {
      el2.classList.toggle('is-sel', el2.dataset.uid === uid);
    }
  }

  function openDrawerIfNarrow() {
    if (window.innerWidth > 1180) return;
    el().classList.add('open');
    document.getElementById('scrim').classList.add('on');
  }
  function closeDrawer() {
    el().classList.remove('open');
    if (!document.getElementById('treePane').classList.contains('open')) {
      document.getElementById('scrim').classList.remove('on');
    }
  }

  function init() {
    document.addEventListener('keydown', e => {
      if (e.key === 'Escape') closeDrawer();
    });
    MT.repo.subscribe((ev, detail) => {
      if (ev === 'item:ratings' && detail && detail.uid === currentUid) {
        MT.repo.getItem(currentUid).then(it => it && paint(it));
      }
    });
    empty();
  }

  return { init, show, empty, close: closeDrawer, get current() { return currentUid; } };
})();
