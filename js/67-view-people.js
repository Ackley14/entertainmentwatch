/* ══════════════════════════════════════════════════════════════════════════
   #/people — following directors, actors and studios.

   This is the answer to "track unannounced films". TMDB's /discover has no
   status filter and anchors every query on dates, so a film with status
   "Planned" and no release date is unreachable through it — but
   /person/{id}/combined_credits lists undated projects happily. One request
   per followed person surfaces work before it has a date, including things
   not yet in the library.
   ══════════════════════════════════════════════════════════════════════════ */

MT.viewPeople = (function () {
  const esc = MT.util.escapeHtml;

  async function render() {
    const view = document.getElementById('view');
    const follows = (await MT.repo.allFollows()).sort((a, b) => a.name.localeCompare(b.name));

    view.innerHTML = `
      <div class="pagehead">
        <div>
          <h1>Following</h1>
          <div class="pagehead__sub">${MT.util.pluralize(follows.length, 'person or studio')}</div>
        </div>
      </div>

      <div class="toolbar">
        <input id="follow-q" type="text" placeholder="Search for a director, actor or studio…"
               style="flex:1;min-width:240px;background:var(--ink-050);border:1px solid var(--rule);
                      border-radius:var(--radius);padding:var(--s-2) var(--s-3);color:var(--bone-100)">
      </div>
      <div id="follow-results"></div>

      ${follows.length ? `
        <section class="section" style="margin-top:var(--s-6)">
          ${MT.ui.ruleHead('Upcoming from people you follow')}
          <div id="follow-upcoming">${MT.ui.skeletonGrid(6)}</div>
        </section>

        <section class="section">
          ${MT.ui.ruleHead('Roster')}
          <div class="grid">${follows.map(followCard).join('')}</div>
        </section>`
      : MT.ui.emptyState({
          title: 'Follow someone',
          body: 'Follow a director, an actor or a studio and MovieTrak will tell you when they attach to something new — usually long before it has a release date.',
        })}`;

    const q = document.getElementById('follow-q');
    const results = document.getElementById('follow-results');

    q.addEventListener('input', MT.util.debounce(async () => {
      const term = q.value.trim();
      if (term.length < 2) { results.innerHTML = ''; return; }
      if (!MT.config.hasKey('tmdb')) {
        results.innerHTML = MT.ui.errorBox('No TMDB key', 'Add one in Settings first.');
        return;
      }
      results.innerHTML = '<div class="row__group">Searching…</div>';
      try {
        const [people, companies] = await Promise.all([
          MT.tmdb.searchPerson(term).catch(() => []),
          MT.tmdb.searchCompany(term).catch(() => []),
        ]);
        const existing = new Set((await MT.repo.allFollows()).map(f => f.id));
        results.innerHTML = renderResults(people.slice(0, 6), companies.slice(0, 4), existing);
      } catch (e) {
        results.innerHTML = MT.ui.errorBox('Search failed', e.message || '');
      }
    }, 250));

    results.addEventListener('click', async e => {
      const btn = e.target.closest('[data-follow]');
      if (!btn) return;
      const { type, id, name, img } = btn.dataset;
      await MT.repo.putFollow({
        id: `${type}:tmdb:${id}`, type, source: 'tmdb', sourceId: +id,
        name, imagePath: img || null, addedAt: Date.now(),
        lastCheckedAt: 0, knownWorkIds: [], muted: 0,
      });
      MT.ui.toast(`Following ${name}`);
      MT.router.resolve();
    });

    view.addEventListener('click', async e => {
      const un = e.target.closest('[data-unfollow]');
      if (!un) return;
      e.preventDefault();
      await MT.repo.deleteFollow(un.dataset.unfollow);
      MT.ui.toast('Unfollowed');
      MT.router.resolve();
    });

    if (follows.length) loadUpcoming(follows);
  }

  function renderResults(people, companies, existing) {
    if (!people.length && !companies.length) return '<div class="row__group">No matches</div>';
    let html = '';
    if (people.length) {
      html += '<div class="row__group"><span>People</span></div>';
      for (const p of people) {
        const id = `person:tmdb:${p.id}`;
        html += `<div class="row">
          ${p.profile_path ? `<img class="row__art" src="${esc(MT.tmdb.img(p.profile_path, MT.IMG.profile.sm))}" alt="">`
                           : '<span class="row__art"></span>'}
          <div class="row__main">
            <div class="row__title">${esc(p.name)}</div>
            <div class="row__meta">${esc(p.known_for_department || '')}
              ${(p.known_for || []).slice(0, 2).map(k => esc(k.title || k.name)).join(' · ')}</div>
          </div>
          <div class="row__act">${existing.has(id)
            ? '<span class="row__in">✓ Following</span>'
            : `<button class="btn btn--sm" data-follow data-type="person" data-id="${p.id}"
                 data-name="${esc(p.name)}" data-img="${esc(p.profile_path || '')}">Follow</button>`}</div>
        </div>`;
      }
    }
    if (companies.length) {
      html += '<div class="row__group"><span>Studios</span></div>';
      for (const c of companies) {
        const id = `company:tmdb:${c.id}`;
        html += `<div class="row">
          <span class="row__art"></span>
          <div class="row__main"><div class="row__title">${esc(c.name)}</div>
            <div class="row__meta">${esc(c.origin_country || '')}</div></div>
          <div class="row__act">${existing.has(id)
            ? '<span class="row__in">✓ Following</span>'
            : `<button class="btn btn--sm" data-follow data-type="company" data-id="${c.id}"
                 data-name="${esc(c.name)}" data-img="">Follow</button>`}</div>
        </div>`;
      }
    }
    return html;
  }

  function followCard(f) {
    const face = f.imagePath ? MT.tmdb.img(f.imagePath, MT.IMG.profile.md) : null;
    return `<div class="card">
      <div class="card__art${face ? '' : ' card__art--empty'}">
        ${face ? `<img loading="lazy" src="${esc(face)}" alt="">` : esc(f.name)}
        <span class="card__kind">${f.type === 'company' ? 'Studio' : 'Person'}</span>
      </div>
      <div class="card__title">${esc(f.name)}</div>
      <div class="card__sub">
        <span>${f.knownWorkIds ? f.knownWorkIds.length : 0} known works</span>
        <button class="chip" data-unfollow="${esc(f.id)}">Unfollow</button>
      </div>
    </div>`;
  }

  async function loadUpcoming(follows) {
    const host = document.getElementById('follow-upcoming');
    if (!host || !MT.config.hasKey('tmdb')) { if (host) host.innerHTML = ''; return; }
    const today = MT.util.todaySortKey();
    const owned = new Set((await MT.repo.allItems()).map(i => i.uid));
    const seen = new Map();

    for (const f of follows.slice(0, 8)) {
      try {
        const credits = f.type === 'company'
          ? { crew: await MT.tmdb.companyReleases(f.sourceId) }
          : await MT.tmdb.personCredits(f.sourceId);
        const works = [].concat(credits.cast || [], credits.crew || []);
        for (const w of works) {
          const kind = w.media_type === 'tv' ? 'tv' : 'movie';
          const uid = MT.normalize.uidOf(kind, 'tmdb', w.id);
          if (owned.has(uid) || seen.has(uid)) continue;
          const stub = MT.normalize.stubFromTmdbSearch(Object.assign({ media_type: kind }, w));
          /* Undated projects are the whole point of this screen, so they are
             kept, not filtered out for lacking a date. */
          const undated = stub.release.sortKey >= MT.util.SK_UNKNOWN;
          if (!undated && stub.release.sortKey < today) continue;
          stub._via = f.name;
          seen.set(uid, stub);
        }
      } catch (_) { /* one bad follow must not empty the screen */ }
    }

    const list = [...seen.values()]
      .sort((a, b) => a.release.sortKey - b.release.sortKey)
      .slice(0, 18);

    host.innerHTML = list.length
      ? '<div class="grid">' + list.map(s => `
          <div class="rec">${MT.ui.posterCard(s, { hideStatus: true })}
            <div class="rec__why">via <b>${esc(s._via)}</b></div>
            <div class="rec__act"><button class="btn btn--sm" data-addfollow="${esc(s.uid)}">Add</button></div>
          </div>`).join('') + '</div>'
      : MT.ui.emptyState({ title: 'Nothing upcoming', body: 'No unreleased projects from these follows right now.' });

    host.addEventListener('click', async e => {
      const btn = e.target.closest('[data-addfollow]');
      if (!btn) return;
      e.preventDefault();
      const stub = seen.get(btn.dataset.addfollow);
      if (stub) {
        delete stub._via;
        await MT.ui.addItem(stub, { source: 'follow_alert' });
        btn.outerHTML = '<span class="row__in">✓ Added</span>';
      }
    });
  }

  /* ── #/person/:id — a read-only filmography ────────────────────────── */
  async function renderPerson(params) {
    const view = document.getElementById('view');
    const id = params.id;
    view.innerHTML = MT.ui.skeletonGrid(8);
    try {
      const [p, credits] = await Promise.all([MT.tmdb.person(id), MT.tmdb.personCredits(id)]);
      const follows = await MT.repo.allFollows();
      const following = follows.some(f => f.id === `person:tmdb:${id}`);
      const owned = new Set((await MT.repo.allItems()).map(i => i.uid));

      const works = [].concat(credits.cast || [], credits.crew || []);
      const stubs = MT.util.uniqBy(works.map(w => {
        const kind = w.media_type === 'tv' ? 'tv' : 'movie';
        return MT.normalize.stubFromTmdbSearch(Object.assign({ media_type: kind }, w));
      }), s => s.uid).sort((a, b) => b.release.sortKey - a.release.sortKey);

      const upcoming = stubs.filter(s => s.release.sortKey >= MT.util.todaySortKey()
                                      || s.release.sortKey >= MT.util.SK_UNKNOWN);
      const past = stubs.filter(s => !upcoming.includes(s));

      view.innerHTML = `
        <div class="pagehead">
          <div>
            <h1>${esc(p.name)}</h1>
            <div class="pagehead__sub">${esc(p.known_for_department || '')} · ${stubs.length} credits</div>
          </div>
          <div class="pagehead__act">
            <button class="btn ${following ? '' : 'btn--primary'}" id="follow-toggle">
              ${following ? 'Unfollow' : 'Follow'}</button>
          </div>
        </div>
        ${upcoming.length ? `<section class="section">${MT.ui.ruleHead('Upcoming & undated')}
          <div class="grid">${upcoming.map(s => MT.ui.posterCard(
            owned.has(s.uid) ? Object.assign({}, s, { user: { status: 'want' } }) : s)).join('')}</div></section>` : ''}
        ${past.length ? `<section class="section">${MT.ui.ruleHead('Released')}
          <div class="grid">${past.slice(0, 40).map(s => MT.ui.posterCard(s, { hideStatus: true })).join('')}</div></section>` : ''}`;

      document.getElementById('follow-toggle').onclick = async () => {
        if (following) await MT.repo.deleteFollow(`person:tmdb:${id}`);
        else await MT.repo.putFollow({
          id: `person:tmdb:${id}`, type: 'person', source: 'tmdb', sourceId: +id,
          name: p.name, imagePath: p.profile_path, addedAt: Date.now(),
          lastCheckedAt: 0, knownWorkIds: [], muted: 0,
        });
        MT.router.resolve();
      };
    } catch (e) {
      view.innerHTML = MT.ui.errorBox('Could not load that person', (e && e.message) || String(e));
    }
  }

  return { render, renderPerson };
})();
