/* ══════════════════════════════════════════════════════════════════════════
   #/recs — For You.

   Building a slate is the single most expensive thing the app does (~45 TMDB
   requests), so it is never triggered by opening a page. The cached slate is
   keyed on a fingerprint of the library, which means it refreshes when your
   taste actually changes rather than on a timer.
   ══════════════════════════════════════════════════════════════════════════ */

MT.viewRecs = (function () {
  const esc = MT.util.escapeHtml;

  async function render(params, query) {
    const view = document.getElementById('view');
    const kind = (query && query.kind) || 'movie';
    MT.ui.crumb(['Discover', 'For you']);
    MT.ui.paneActions(`
      <div class="seg">
        ${[['movie', 'Films'], ['tv', 'TV'], ['game', 'Games']].map(([k, l]) =>
          `<button type="button" data-kind="${k}" aria-pressed="${k === kind}">${l}</button>`).join('')}
      </div>
      <button class="btn btn--sm" id="rebuild">Rebuild</button>`);

    const pa = document.getElementById('paneActions');
    pa.addEventListener('click', e => {
      const k = e.target.closest('[data-kind]');
      if (k) MT.router.go('#/recs?kind=' + k.dataset.kind);
    });
    document.getElementById('rebuild').onclick = () => load(kind, true);

    view.innerHTML = `
      <div class="toolbar">
        <label class="muted" style="display:flex;align-items:center;gap:8px;font-size:var(--mt-fs-sm)">
          Surprise me
          <input type="range" id="novelty" min="0" max="0.6" step="0.05" value="${MT.config.get('novelty')}" style="width:110px">
        </label>
        <div class="spacer"></div>
        <span class="count" id="recCount"></span>
      </div>
      <div id="recBody"></div>
      <p class="faint" style="font-size:var(--mt-fs-micro);padding:var(--mt-space-6);max-width:70ch;line-height:1.5">
        Recommendations are computed on your device using cosine similarity over TF-IDF vectors.
        No AI model is involved.
      </p>`;

    document.getElementById('novelty').onchange = e => {
      MT.config.set('novelty', parseFloat(e.target.value));
      load(kind, true);
    };
    load(kind, false);
  }

  async function load(kind, force) {
    const host = document.getElementById('recBody');
    if (!host) return;
    if (kind === 'game') return games(host);

    if (!MT.config.hasKey('tmdb')) {
      host.innerHTML = MT.ui.emptyState({ title: 'No TMDB key',
        body: 'Add a key in Settings to get recommendations.',
        actions: '<a class="btn btn--primary" href="#/settings">Settings</a>' });
      return;
    }

    const fp = await MT.rec.libraryFingerprint(kind);
    const hit = await MT.repo.metaGet('rec.slate:' + kind);
    const fresh = hit && hit.fp === fp && Date.now() - hit.at < MT.TTL.recSlate;

    if (!fresh && !force) {
      host.innerHTML = MT.ui.emptyState({
        title: hit ? 'Your library has changed' : 'Ready when you are',
        body: hit
          ? 'Rebuild to take the new titles into account. This costs about 45 requests, so it only happens when you ask.'
          : 'Build a taste profile from your library and see what it turns up. About 45 requests, once.',
        actions: '<button class="btn btn--primary" id="build">Build recommendations</button>',
      });
      const b = document.getElementById('build');
      if (b) b.onclick = () => load(kind, true);
      return;
    }

    host.innerHTML = MT.ui.skeletonGrid(12);
    try {
      const res = await MT.rec.cachedSlate(kind, { force });
      if (res.empty) {
        host.innerHTML = MT.ui.emptyState({
          title: 'Not enough to go on yet',
          body: 'Add a few films or shows you like — ideally rate them — and a taste profile builds itself.',
          actions: '<a class="btn btn--primary" href="#/library">Open library</a>' });
        return;
      }
      if (!res.items.length) {
        host.innerHTML = MT.ui.emptyState({ title: 'Nothing new to suggest',
          body: 'Everything that scored well is already in your index or dismissed.' });
        return;
      }
      paint(host, res.items);
      const c = document.getElementById('recCount');
      if (c) c.textContent = `${res.items.length} suggestions`;
    } catch (e) {
      host.innerHTML = MT.ui.errorBox('Could not build recommendations', e.message || String(e));
    }
  }

  function paint(host, items) {
    host.innerHTML = `<div class="grid">${items.map(r => `
      <div class="card" data-rec="${esc(r.uid)}">
        ${MT.ui.poster(r.item)}
        <div class="ct">${esc(r.item.title)}</div>
        <div class="why-line ${r.reason.kind === 'graph' ? 'graph' : ''}">${r.reason.text}</div>
        <div style="display:flex;gap:4px;margin-top:6px">
          <button class="btn btn--sm" data-add="${esc(r.uid)}">Add</button>
          <button class="btn btn--sm btn--ghost" data-dismiss="${esc(r.uid)}">Not for me</button>
        </div>
      </div>`).join('')}</div>`;

    host.onclick = async e => {
      const add = e.target.closest('[data-add]');
      const dis = e.target.closest('[data-dismiss]');
      const card = e.target.closest('[data-rec]');

      if (add) {
        const rec = items.find(r => r.uid === add.dataset.add);
        const { kind, id } = MT.normalize.parseUid(rec.uid);
        try {
          await MT.ui.addItem(MT.normalize.fromTmdb(await MT.tmdb.details(kind, id), kind), { source: 'recommendation' });
          add.outerHTML = '<span class="add">✓ Added</span>';
        } catch (_) { MT.ui.toast('Could not add that title', { bad: true }); }
        return;
      }
      if (dis) {
        const rec = items.find(r => r.uid === dis.dataset.dismiss);
        await MT.repo.dismiss(rec.uid, rec.item.kind, 'not_interested', rec.item.title);
        const c = dis.closest('.card');
        c.style.display = 'none';
        MT.ui.toast('Hidden from recommendations', {
          actionLabel: 'Undo',
          onAction: async () => { await MT.repo.undismiss(rec.uid); c.style.display = ''; },
        });
        return;
      }
      if (card) MT.inspector.show(card.dataset.rec);
    };
  }

  /* Games are honestly weaker and the UI says so rather than pretending:
     IGDB's similar_games is the only real similarity graph in the ecosystem
     and it cannot be called from a browser at all. */
  async function games(host) {
    if (!MT.config.hasKey('rawg')) {
      host.innerHTML = MT.ui.emptyState({ title: 'No RAWG key',
        body: 'Add a free RAWG key in Settings to include games.',
        actions: '<a class="btn btn--primary" href="#/settings">Settings</a>' });
      return;
    }
    host.innerHTML = MT.ui.skeletonGrid(8);
    try {
      const profile = await MT.rec.buildProfile('game');
      if (profile.empty) {
        host.innerHTML = MT.ui.emptyState({ title: 'No games in your index yet', body: 'Add a few first.' });
        return;
      }
      const semantics = await MT.rawg.tagSemantics();
      const tags = MT.rec.topTerms(profile, 30)
        .filter(t => t.term.startsWith('tag:') || t.term.startsWith('kw:'))
        .map(t => t.term.split(':').pop()).slice(0, 6);
      const owned = new Set((await MT.repo.allItems()).map(i => i.uid));
      const dismissed = await MT.repo.dismissedSet();
      const seen = new Map();

      const queries = semantics === 'or'
        ? [{ tags: tags.join(','), ordering: '-added' }]
        : tags.slice(0, 3).map((t, i) => ({ tags: [t, tags[(i + 1) % tags.length]].join(','), ordering: '-added' }));

      for (const q of queries) {
        const rs = await MT.rawg.byFilters(Object.assign({ page_size: 20, exclude_additions: true }, q));
        for (const r of rs) {
          const uid = MT.normalize.uidOf('game', 'rawg', r.id);
          if (owned.has(uid) || dismissed.has(uid) || seen.has(uid)) continue;
          seen.set(uid, MT.normalize.stubFromRawgSearch(r));
        }
      }
      const list = [...seen.values()].slice(0, 24);
      host.innerHTML = list.length ? `
        <p class="muted" style="padding:var(--mt-space-4) var(--mt-space-6);font-size:var(--mt-fs-sm);max-width:66ch;line-height:1.6">
          Game suggestions come from shared tags, not a similarity graph — IGDB, the only game database with
          one, blocks browser requests entirely. Expect these to be rougher than the film and television lists.
        </p>
        <div class="grid">${list.map(g => `
          <div class="card" data-gadd="${esc(g.uid)}">
            ${MT.ui.poster(g)}
            <div class="ct">${esc(g.title)}</div>
            <div class="why-line">Shares tags with games in your index</div>
          </div>`).join('')}</div>`
        : MT.ui.emptyState({ title: 'Nothing to suggest', body: 'RAWG returned no new matches for your tag profile.' });

      host.onclick = async e => {
        const c = e.target.closest('[data-gadd]');
        if (!c) return;
        const stub = seen.get(c.dataset.gadd);
        if (stub) { await MT.ui.addItem(stub, { source: 'recommendation' }); MT.inspector.show(stub.uid); }
      };
    } catch (e) {
      host.innerHTML = MT.ui.errorBox('Could not load game suggestions', e.message || String(e));
    }
  }

  return { render };
})();
