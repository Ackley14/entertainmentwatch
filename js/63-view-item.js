/* ══════════════════════════════════════════════════════════════════════════
   #/item/:uid — the detail screen.

   Paints immediately from what is stored, then patches in anything slower
   (OMDb ratings, AniList enrichment, recommendations) as it lands. Nothing on
   this page may block on a network call — OMDb in particular is unmaintained
   and may simply never answer.
   ══════════════════════════════════════════════════════════════════════════ */

MT.viewItem = (function () {
  const esc = MT.util.escapeHtml;

  async function render(params) {
    const view = document.getElementById('view');
    const uid = params.uid;
    let item = await MT.repo.getItem(uid);

    if (!item) {
      /* Not in the library — could be a recommendation or a shared link.
         Fetch it read-only so the page still works. */
      view.innerHTML = MT.ui.skeletonGrid(1);
      try { item = await fetchTransient(uid); }
      catch (e) {
        view.innerHTML = MT.ui.errorBox('Could not load this title', (e && e.message) || String(e));
        return;
      }
      if (!item) {
        view.innerHTML = MT.ui.emptyState({ title: 'Not found', body: 'That title is not in your library.' });
        return;
      }
      item._transient = true;
    }

    paint(view, item);

    if (!item._transient) {
      MT.ui.hydrate(uid).then(fresh => {
        if (fresh && location.hash.includes(encodeURIComponent(uid))) {
          MT.repo.getItem(uid).then(cur => cur && paint(view, cur));
        }
      }).catch(() => {});
    }
    loadMoreLikeThis(item);
  }

  async function fetchTransient(uid) {
    const { kind, source, id } = MT.normalize.parseUid(uid);
    if (source === 'tmdb') {
      const raw = await MT.tmdb.details(kind, id);
      return MT.normalize.withDefaults(MT.normalize.fromTmdb(raw, kind), 'want', 'link');
    }
    if (source === 'rawg') {
      const raw = await MT.rawg.game(id);
      return MT.normalize.withDefaults(MT.normalize.fromRawg(raw), 'want', 'link');
    }
    return null;
  }

  function paint(view, item) {
    const poster = MT.ui.posterUrl(item, MT.IMG.poster.lg);
    const rel = item.release || {};
    const dir = (item.people || []).filter(p => p.role === 'director' || p.role === 'creator');
    const cast = (item.people || []).filter(p => p.role === 'cast').slice(0, 8);

    view.innerHTML = `
      <div class="item__hero">
        <div>
          ${poster ? `<img class="item__poster" src="${esc(poster)}" alt="">`
                   : '<div class="item__poster"></div>'}
        </div>
        <div>
          <h1 class="item__title">${esc(item.title)}</h1>
          ${item.originalTitle && item.originalTitle !== item.title
            ? `<div class="item__orig">${esc(item.originalTitle)}</div>` : ''}

          <div class="item__facts">
            <span>${kindLabel(item)}</span>
            <span>${MT.ui.dateChip(rel)}</span>
            ${MT.ui.statusPill(rel) ? `<span>${MT.ui.statusPill(rel)}</span>` : ''}
            ${MT.ui.driftBadge(rel) ? `<span>${MT.ui.driftBadge(rel)}</span>` : ''}
            ${item.runtimeMin ? `<span>${esc(MT.util.runtimeStr(item.runtimeMin))}</span>` : ''}
            ${certOf(item) ? `<span>${esc(certOf(item))}</span>` : ''}
          </div>

          ${item.tagline ? `<p class="item__tagline">“${esc(item.tagline)}”</p>` : ''}

          <div class="ratings" id="ratings">${ratingsHtml(item)}</div>

          ${item.overview ? `<div class="item__overview prose"><p>${esc(item.overview)}</p></div>` : ''}

          <div class="item__actions">${actionsHtml(item)}</div>
        </div>
      </div>

      <div class="item__cols">
        <div>
          ${dir.length || cast.length ? `
            <section class="section">
              ${MT.ui.ruleHead(item.kind === 'game' ? 'Made by' : 'Cast & crew')}
              <div class="people">
                ${dir.map(p => personHtml(p)).join('')}
                ${cast.map(p => personHtml(p)).join('')}
                ${(item.kind === 'game' ? item.companies || [] : []).slice(0, 4)
                  .map(c => `<div class="person"><span class="person__face"></span>
                    <div><div class="person__name">${esc(c.name)}</div>
                    <div class="person__role">${esc(c.role)}</div></div></div>`).join('')}
              </div>
            </section>` : ''}

          <section class="section" id="mlt">
            ${MT.ui.ruleHead('If you like this')}
            <div id="mlt-body">${MT.ui.skeletonGrid(6)}</div>
          </section>
        </div>

        <aside>
          ${item._transient ? '' : entryDeck(item)}
          ${releaseDeck(item)}
          ${providersDeck(item)}
          ${linksDeck(item)}
        </aside>
      </div>`;

    wire(view, item);
  }

  function kindLabel(item) {
    if (item.facets && item.facets.anime) return 'Anime';
    return item.kind === 'tv' ? 'Television' : item.kind === 'game' ? 'Game' : 'Film';
  }
  function certOf(item) {
    const region = MT.config.get('region') || 'US';
    return (item.certification || {})[region] || '';
  }

  /* ── Ratings ──────────────────────────────────────────────────────────
     Sources that do not cover this medium are omitted entirely; sources that
     do but have no score show a muted dash. Those are different facts and
     rendering them the same way makes missing data look like a bug. */
  function ratingsHtml(item) {
    const r = item.ratings || {};
    const out = [];

    if (item.user && item.user.rating != null) {
      out.push(MT.ui.ratingTile('user', { score: item.user.rating }));
    }
    if (item.kind === 'game') {
      out.push(MT.ui.ratingTile('rawg', r.rawg));
      out.push(MT.ui.ratingTile('metacritic', r.metacritic));
    } else {
      out.push(MT.ui.ratingTile('imdb', r.imdb, { pending: !r.imdb && MT.config.hasKey('omdb') && item.ids.imdb }));
      out.push(MT.ui.ratingTile('tmdb', r.tmdb));
      /* Rotten Tomatoes and Metacritic have effectively no television
         coverage through OMDb, so for TV they are not rendered at all rather
         than shown as permanently empty. */
      if (MT.omdb.coversRtMetacritic(item.kind)) {
        out.push(MT.ui.ratingTile('rt', r.rottenTomatoes, { pending: !r.rottenTomatoes && MT.config.hasKey('omdb') && item.ids.imdb }));
        out.push(MT.ui.ratingTile('metacritic', r.metacritic, { pending: !r.metacritic && MT.config.hasKey('omdb') && item.ids.imdb }));
      }
      if (item.facets && item.facets.anime) out.push(MT.ui.ratingTile('anilist', r.anilist));
    }
    return out.join('');
  }

  function actionsHtml(item) {
    if (item._transient) {
      return `<button class="btn btn--primary" data-act="add">Add to library</button>
              ${item.links.imdb ? `<a class="btn" href="${esc(item.links.imdb)}" target="_blank" rel="noopener">IMDb ↗</a>` : ''}`;
    }
    const s = item.user.status;
    return ['want', 'watching', 'watched', 'dropped'].map(x =>
      `<button class="btn ${x === s ? 'btn--primary' : ''}" data-status="${x}">${MT.ui.statusWord(x)}</button>`
    ).join('') + `<button class="btn btn--ghost btn--danger" data-act="remove">Remove</button>`;
  }

  function personHtml(p) {
    const face = p.profilePath ? MT.tmdb.img(p.profilePath, MT.IMG.profile.sm) : null;
    return `<a class="person" href="#/person/${p.id}">
      ${face ? `<img class="person__face" loading="lazy" src="${esc(face)}" alt="">`
             : '<span class="person__face"></span>'}
      <div style="min-width:0">
        <div class="person__name">${esc(p.name)}</div>
        <div class="person__role">${esc(p.character || p.role)}</div>
      </div></a>`;
  }

  function entryDeck(item) {
    const u = item.user;
    return `<div class="deck entry">
      <div class="deck__label">Your entry</div>
      <div class="entry__field">
        <label>Rating</label>
        <div class="stars" data-stars>
          ${[1,2,3,4,5,6,7,8,9,10].map(n =>
            `<button data-rate="${n}" class="${u.rating >= n ? 'on' : ''}" title="${n}/10">★</button>`).join('')}
          ${u.rating != null ? '<button data-rate="0" title="Clear" style="margin-left:6px;color:var(--bone-400)">✕</button>' : ''}
        </div>
      </div>
      <div class="entry__field">
        <label for="notes">Notes</label>
        <textarea id="notes" rows="4" placeholder="Why you want to see it, who recommended it…">${esc(u.notes || '')}</textarea>
      </div>
      <div class="entry__field">
        <label for="tags">Tags</label>
        <input id="tags" type="text" value="${esc((u.tags || []).join(', '))}" placeholder="comma, separated">
      </div>
      <div class="entry__field">
        <label>Priority</label>
        <div class="seg">
          ${[0,1,2,3].map(n => `<button data-prio="${n}" aria-pressed="${(u.priority||0)===n}">${['—','Low','Med','High'][n]}</button>`).join('')}
        </div>
      </div>
    </div>`;
  }

  function releaseDeck(item) {
    const rel = item.release || {};
    const windows = (rel.windows || []).filter(w => w.raw);
    const hist = rel.history || [];
    return `<div class="deck">
      <div class="deck__label">Release</div>
      <dl>
        <dt>Status</dt><dd>${esc(MT.alerts.prettyStatus(rel.status))}</dd>
        <dt>Date</dt><dd>${esc(rel.display || '—')}</dd>
        <dt>Precision</dt><dd>${esc(rel.precision)}${rel.inferred ? ' (inferred)' : ''}</dd>
        ${item.tvExtra && item.tvExtra.nextEpisode
          ? `<dt>Next episode</dt><dd>${item.tvExtra.nextEpisode.season}×${String(item.tvExtra.nextEpisode.episode).padStart(2,'0')} ${esc(item.tvExtra.nextEpisode.airDate || '')}</dd>` : ''}
        ${item.tvExtra ? `<dt>Seasons</dt><dd>${item.tvExtra.seasonCount} / ${item.tvExtra.episodeCount} eps</dd>` : ''}
        ${item.gameExtra && item.gameExtra.playtimeHours
          ? `<dt>Typical length</dt><dd>${item.gameExtra.playtimeHours}h</dd>` : ''}
      </dl>
      ${windows.length > 1 ? `<div style="margin-top:var(--s-3)">
        ${windows.map(w => `<div class="linkout"><span>${esc(w.type)}</span>
          <span class="linkout__id">${esc(MT.util.displayRelease(MT.util.sortKeyToParts(w.sortKey), w.precision))}</span></div>`).join('')}
      </div>` : ''}
      ${hist.length ? `<div style="margin-top:var(--s-3)">
        <div class="deck__label">Date history</div>
        ${hist.slice().reverse().slice(0, 5).map(h => `<div class="linkout">
          <span class="linkout__id">${esc(MT.util.displayRelease(MT.util.sortKeyToParts(h.from.sortKey), h.from.precision))} → ${esc(MT.util.displayRelease(MT.util.sortKeyToParts(h.to.sortKey), h.to.precision))}</span>
          <span class="linkout__id">${esc(MT.util.timeAgo(h.observedAt))}</span></div>`).join('')}
      </div>` : ''}
    </div>`;
  }

  /* JustWatch must be credited INLINE where its data appears, not in the
     global footer — that is what their terms require, and failing it is an
     access-revocation condition rather than a nicety. */
  function providersDeck(item) {
    const p = item.providers;
    if (!p) return '';
    const mine = new Set(MT.config.get('myProviders') || []);
    const group = (label, list) => (list && list.length) ? `
      <div>
        <div class="provider__group">${label}</div>
        <div class="provider__logos">
          ${list.map(x => `<img class="provider__logo${mine.has(x.id) ? ' provider__logo--mine' : ''}"
             src="${esc(MT.tmdb.img(x.logoPath, MT.IMG.logo.sm))}" alt="${esc(x.name)}" title="${esc(x.name)}">`).join('')}
        </div>
      </div>` : '';
    const body = group('Streaming', p.flatrate) + group('Free', p.free) + group('With ads', p.ads)
               + group('Rent', p.rent) + group('Buy', p.buy);
    if (!body) return '';
    return `<div class="deck">
      <div class="deck__label">Where to watch <span class="dim">${esc(p.region)}</span></div>
      <div class="providers">${body}</div>
      <div class="justwatch">Data by <a href="${esc(p.link || 'https://www.justwatch.com/')}" target="_blank" rel="noopener">JustWatch</a></div>
    </div>`;
  }

  function linksDeck(item) {
    const L = item.links || {};
    const rows = [
      ['IMDb', L.imdb, item.ids.imdb],
      ['TMDB', L.tmdb, item.ids.tmdb],
      ['Letterboxd', L.letterboxd, null],
      ['AniList', L.anilist, item.ids.anilist],
      ['RAWG', L.rawg, item.ids.rawg],
      ['Steam', L.steam, item.ids.steam],
      ['Official site', item.homepage, null],
    ].filter(r => r[1]);
    if (!rows.length) return '';
    return `<div class="deck">
      <div class="deck__label">Elsewhere</div>
      ${rows.map(([label, href, id]) => `<a class="linkout" href="${esc(href)}" target="_blank" rel="noopener">
        <span>${esc(label)} ↗</span>${id ? `<span class="linkout__id">${esc(id)}</span>` : ''}</a>`).join('')}
    </div>`;
  }

  async function loadMoreLikeThis(item) {
    const host = document.getElementById('mlt-body');
    if (!host) return;
    /* A heading with nothing under it reads as a broken page, so the whole
       section is removed rather than left empty. */
    const drop = () => { const s = document.getElementById('mlt'); if (s) s.remove(); };

    if (item.kind === 'game') {
      host.innerHTML = MT.ui.emptyState({
        title: 'Limited for games',
        body: 'RAWG has no similarity graph, so game suggestions come from shared tags on the For You screen.',
      });
      return;
    }
    if (!MT.config.hasKey('tmdb')) { drop(); return; }
    try {
      const recs = await MT.rec.moreLikeThis(item);
      if (!recs.length) { drop(); return; }
      host.innerHTML = '<div class="grid">' +
        recs.map(r => MT.ui.posterCard(r.item, { hideStatus: true })).join('') + '</div>';
    } catch (e) {
      host.innerHTML = MT.ui.errorBox('Could not load suggestions', (e && e.message) || '');
    }
  }

  function wire(view, item) {
    const save = MT.util.debounce(async patch => {
      const cur = await MT.repo.getItem(item.uid);
      if (!cur) return;
      Object.assign(cur.user, patch);
      await MT.repo.putItem(cur);
    }, 400);

    view.addEventListener('click', async e => {
      const st = e.target.closest('[data-status]');
      const rate = e.target.closest('[data-rate]');
      const prio = e.target.closest('[data-prio]');
      const act = e.target.closest('[data-act]');

      if (st) { await MT.ui.setStatus(item.uid, st.dataset.status); MT.router.resolve(); }
      if (rate) {
        const n = +rate.dataset.rate;
        const cur = await MT.repo.getItem(item.uid);
        if (!cur) return;
        if (n === 0) delete cur.user.rating; else cur.user.rating = n;
        await MT.repo.putItem(cur);
        MT.repo.addHistory(item.uid, 'rated', n || null);
        MT.router.resolve();
      }
      if (prio) { await save({ priority: +prio.dataset.prio }); MT.router.resolve(); }
      if (act && act.dataset.act === 'add') {
        delete item._transient;
        await MT.ui.addItem(item, { source: 'link' });
        MT.router.resolve();
      }
      if (act && act.dataset.act === 'remove') {
        if (MT.ui.confirmDialog(`Remove “${item.title}” from your library?`)) {
          await MT.repo.deleteItem(item.uid);
          MT.ui.toast('Removed');
          MT.router.go('#/list');
        }
      }
    });

    const notes = view.querySelector('#notes');
    if (notes) notes.addEventListener('input', () => save({ notes: notes.value }));
    const tags = view.querySelector('#tags');
    if (tags) tags.addEventListener('input', () =>
      save({ tags: tags.value.split(',').map(s => s.trim()).filter(Boolean) }));
  }

  return { render };
})();
