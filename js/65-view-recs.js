/* ══════════════════════════════════════════════════════════════════════════
   #/recs — For You.
   ══════════════════════════════════════════════════════════════════════════ */

MT.viewRecs = (function () {
  const esc = MT.util.escapeHtml;

  async function render(params, query) {
    const view = document.getElementById('view');
    const kind = (query && query.kind) || 'movie';
    const all = await MT.repo.allItems();
    const seeds = all.filter(it => it.kind === kind && it.rec && it.rec.seedEligible
                               && it.user.status !== 'dropped');

    view.innerHTML = `
      <div class="pagehead">
        <div>
          <h1>For You</h1>
          <div class="pagehead__sub">Built from ${MT.util.pluralize(seeds.length, 'title')} in your library</div>
        </div>
        <div class="pagehead__act">
          <button class="btn" id="refresh-recs">Refresh</button>
        </div>
      </div>

      <div class="toolbar">
        <div class="seg">
          ${[['movie', 'Films'], ['tv', 'Television'], ['game', 'Games']].map(([k, l]) =>
            `<button data-kind="${k}" aria-pressed="${k === kind}">${l}</button>`).join('')}
        </div>
        <div class="toolbar__spacer"></div>
        <label class="muted" style="font-size:var(--t-sm);display:flex;align-items:center;gap:8px">
          Surprise me
          <input type="range" id="novelty" min="0" max="0.6" step="0.05"
                 value="${MT.config.get('novelty')}" style="width:110px">
        </label>
      </div>

      <div id="recs-body">${MT.ui.skeletonGrid(12)}</div>

      <p class="dim" style="font-size:var(--t-xs);margin-top:var(--s-7);max-width:70ch">
        Recommendations are computed on your device using cosine similarity over TF-IDF vectors.
        No AI model is involved.
      </p>`;

    view.querySelector('.toolbar').addEventListener('click', e => {
      const k = e.target.closest('[data-kind]');
      if (k) MT.router.go('#/recs?kind=' + k.dataset.kind);
    });
    const nov = document.getElementById('novelty');
    nov.addEventListener('change', () => {
      MT.config.set('novelty', parseFloat(nov.value));
      load(kind, true);
    });
    document.getElementById('refresh-recs').onclick = () => load(kind, true);

    load(kind, false);
  }

  async function load(kind, force) {
    const host = document.getElementById('recs-body');
    if (!host) return;

    if (kind === 'game') {
      return renderGames(host);
    }
    if (!MT.config.hasKey('tmdb')) {
      host.innerHTML = MT.ui.emptyState({ title: 'No TMDB key',
        body: 'Add a key in Settings to get recommendations.',
        actions: '<a class="btn btn--primary" href="#/settings">Settings</a>' });
      return;
    }

    host.innerHTML = MT.ui.skeletonGrid(12);
    try {
      /* One cache, shared with the home screen, invalidated by a fingerprint of
         the library rather than by a timer — so it rebuilds when your taste
         changes, not on a schedule. */
      const res = await MT.rec.cachedSlate(kind, { force });
      if (res.empty) {
        host.innerHTML = MT.ui.emptyState({
          title: 'Not enough to go on yet',
          body: 'Add a few films or shows you like — ideally rate them — and a taste profile will build itself.',
          actions: '<a class="btn btn--primary" href="#/list">Open library</a>',
        });
        return;
      }
      if (!res.items.length) {
        host.innerHTML = MT.ui.emptyState({ title: 'Nothing new to suggest',
          body: 'Everything that scored well is already in your library or dismissed.' });
        return;
      }
      paint(host, res.items, res.profileTerms);
    } catch (e) {
      host.innerHTML = MT.ui.errorBox('Could not build recommendations', (e && e.message) || String(e));
    }
  }

  function paint(host, items, profileTerms) {
    host.innerHTML = `
      ${profileTerms && profileTerms.length ? `
        <p class="muted" style="font-size:var(--t-sm);margin-bottom:var(--s-5)">
          Your profile right now leans toward
          <a href="#/stats" style="color:var(--amber-100);text-decoration:underline">these ${profileTerms.length} signals</a>.
        </p>` : ''}
      <div class="grid">
        ${items.map(r => `
          <div class="rec" data-uid="${esc(r.uid)}">
            ${MT.ui.posterCard(r.item, { hideStatus: true })}
            <div class="rec__why ${r.reason.kind === 'graph' ? 'rec__why--graph' : ''}">${r.reason.text}</div>
            <div class="rec__act">
              <button class="btn btn--sm" data-add="${esc(r.uid)}">Add</button>
              <button class="btn btn--sm btn--ghost" data-dismiss="${esc(r.uid)}">Not for me</button>
            </div>
          </div>`).join('')}
      </div>`;

    host.addEventListener('click', async e => {
      const add = e.target.closest('[data-add]');
      const dis = e.target.closest('[data-dismiss]');
      if (add) {
        e.preventDefault();
        const rec = items.find(r => r.uid === add.dataset.add);
        const { kind, id } = MT.normalize.parseUid(rec.uid);
        try {
          const raw = await MT.tmdb.details(kind, id);
          await MT.ui.addItem(MT.normalize.fromTmdb(raw, kind), { source: 'recommendation' });
          add.closest('.rec').style.opacity = '.35';
          add.outerHTML = '<span class="row__in">✓ Added</span>';
        } catch (err) { MT.ui.toast('Could not add that title', { bad: true }); }
      }
      if (dis) {
        e.preventDefault();
        const rec = items.find(r => r.uid === dis.dataset.dismiss);
        await MT.repo.dismiss(rec.uid, rec.item.kind, 'not_interested', rec.item.title);
        const card = dis.closest('.rec');
        card.style.display = 'none';
        MT.ui.toast('Hidden from recommendations', {
          actionLabel: 'Undo',
          onAction: async () => { await MT.repo.undismiss(rec.uid); card.style.display = ''; },
        });
      }
    });
  }

  /* Games are honestly weaker and the UI says so rather than pretending.
     RAWG's only free similarity endpoint returns sequels, and the good one
     (IGDB's similar_games) cannot be called from a browser at all. */
  async function renderGames(host) {
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
        host.innerHTML = MT.ui.emptyState({ title: 'No games in your library yet',
          body: 'Add a few and suggestions will appear here.' });
        return;
      }
      const semantics = await MT.rawg.tagSemantics();
      const tags = MT.rec.topTerms(profile, 30)
        .filter(t => t.term.startsWith('tag:rawg:') || t.term.startsWith('kw:'))
        .map(t => t.term.split(':').pop()).slice(0, 6);

      const owned = new Set((await MT.repo.allItems()).map(i => i.uid));
      const dismissed = await MT.repo.dismissedSet();
      const seen = new Map();

      /* The comma's meaning was measured once by MT.rawg.tagSemantics rather
         than guessed — get it backwards and you get either 400k irrelevant
         results or zero, and zero looks exactly like a broken key. */
      const queries = semantics === 'or'
        ? [{ tags: tags.join(','), ordering: '-added' }]
        : tags.slice(0, 4).map((t, i) => ({ tags: [t, tags[(i + 1) % tags.length]].join(','), ordering: '-added' }));

      for (const q of queries) {
        const rs = await MT.rawg.byFilters(Object.assign({ page_size: 20, exclude_additions: true }, q));
        for (const r of rs) {
          const uid = MT.normalize.uidOf('game', 'rawg', r.id);
          if (owned.has(uid) || dismissed.has(uid) || seen.has(uid)) continue;
          seen.set(uid, MT.normalize.stubFromRawgSearch(r));
        }
      }

      const list = [...seen.values()].slice(0, 24);
      if (!list.length) {
        host.innerHTML = MT.ui.emptyState({ title: 'Nothing to suggest',
          body: 'RAWG returned no new matches for your tag profile.' });
        return;
      }
      host.innerHTML = `
        <p class="muted" style="font-size:var(--t-sm);margin-bottom:var(--s-5);max-width:66ch">
          Game suggestions come from shared tags, not a similarity graph — IGDB, the only game database with one,
          blocks browser requests entirely. Expect these to be rougher than the film and television lists.
        </p>
        <div class="grid">${list.map(g => `
          <div class="rec">${MT.ui.posterCard(g, { hideStatus: true })}
            <div class="rec__why">Shares tags with games you have added</div>
          </div>`).join('')}</div>`;
    } catch (e) {
      host.innerHTML = MT.ui.errorBox('Could not load game suggestions', (e && e.message) || String(e));
    }
  }

  return { render };
})();
