/* ══════════════════════════════════════════════════════════════════════════
   #/people — following directors, actors and studios.

   This is the honest answer to "track unannounced films". TMDB's /discover
   has no status filter and anchors every query on dates, so a film with
   status "Planned" and no release date is unreachable through it — but
   /person/{id}/combined_credits lists undated projects happily. One request
   per followed person surfaces work before it has a date.
   ══════════════════════════════════════════════════════════════════════════ */

MT.viewPeople = (function () {
  const esc = MT.util.escapeHtml;

  async function render() {
    const view = document.getElementById('view');
    const follows = (await MT.repo.allFollows()).sort((a, b) => a.name.localeCompare(b.name));
    MT.ui.crumb(['Discover', 'Following']);
    MT.ui.paneActions('');

    view.innerHTML = `
      <div class="searchbox">
        <div class="sfield">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true">
            <circle cx="11" cy="11" r="7"/><path d="M20 20l-3.5-3.5"/>
          </svg>
          <input id="fq" type="search" placeholder="Follow a director, actor or studio…" spellcheck="false" autocomplete="off">
        </div>
        <div class="shint">Following someone surfaces their new projects before those projects have a release date.</div>
      </div>
      <div id="fres"></div>
      ${follows.length ? `
        ${MT.ui.groupHead('Upcoming from your follows')}
        <div id="fup">${MT.ui.skeletonGrid(6)}</div>
        ${MT.ui.groupHead('Roster', follows.length)}
        <div class="grid">${follows.map(card).join('')}</div>`
      : MT.ui.emptyState({
          title: 'Follow someone',
          body: 'Follow a director, an actor or a studio and MovieTrak will tell you when they attach to something new — usually long before it has a date.',
        })}`;

    const q = document.getElementById('fq');
    const res = document.getElementById('fres');
    q.addEventListener('input', MT.util.debounce(async () => {
      const term = q.value.trim();
      if (term.length < 2) { res.innerHTML = ''; return; }
      if (!MT.config.hasKey('tmdb')) { res.innerHTML = MT.ui.errorBox('No TMDB key', 'Add one in Settings first.'); return; }
      res.innerHTML = '<div class="miss muted">Searching…</div>';
      try {
        const [people, companies] = await Promise.all([
          MT.tmdb.searchPerson(term).catch(() => []),
          MT.tmdb.searchCompany(term).catch(() => []),
        ]);
        const have = new Set((await MT.repo.allFollows()).map(f => f.id));
        res.innerHTML = list(people.slice(0, 6), companies.slice(0, 4), have);
      } catch (e) { res.innerHTML = MT.ui.errorBox('Search failed', e.message || ''); }
    }, 250));

    res.addEventListener('click', async e => {
      const b = e.target.closest('[data-follow]');
      if (!b) return;
      const { type, id, name, img } = b.dataset;
      await MT.repo.putFollow({
        id: `${type}:tmdb:${id}`, type, source: 'tmdb', sourceId: +id,
        name, imagePath: img || null, addedAt: Date.now(), lastCheckedAt: 0, knownWorkIds: [], muted: 0,
      });
      MT.ui.toast(`Following ${name}`);
      MT.router.resolve();
    });

    view.onclick = async e => {
      const un = e.target.closest('[data-unfollow]');
      if (un) { await MT.repo.deleteFollow(un.dataset.unfollow); MT.ui.toast('Unfollowed'); MT.router.resolve(); }
    };

    if (follows.length) upcoming(follows);
  }

  function list(people, companies, have) {
    if (!people.length && !companies.length) return '<div class="miss muted">No matches</div>';
    let h = '';
    const row = (kindLabel, type, id, name, sub, img) => {
      const fid = `${type}:tmdb:${id}`;
      return `<div class="miss">
        <span class="chipart" style="width:20px;height:28px;--a:#3E6B78;--b:#16242A">${
          img ? `<img loading="lazy" src="${esc(MT.tmdb.img(img, MT.IMG.profile.sm))}" alt="">` : ''}</span>
        <div style="min-width:0">
          <div style="font-weight:500">${esc(name)}</div>
          <div class="muted" style="font-size:var(--mt-fs-mini)">${esc(kindLabel)}${sub ? ' · ' + esc(sub) : ''}</div>
        </div>
        ${have.has(fid) ? '<span class="add" style="border-color:var(--mt-teal-edge);color:var(--mt-teal-text);background:var(--mt-teal-wash)">✓ Following</span>'
          : `<button class="add" data-follow data-type="${type}" data-id="${id}" data-name="${esc(name)}" data-img="${esc(img || '')}">Follow</button>`}
      </div>`;
    };
    if (people.length) {
      h += MT.ui.groupHead('People');
      for (const p of people) h += row(p.known_for_department || 'Person', 'person', p.id, p.name,
        (p.known_for || []).slice(0, 2).map(k => k.title || k.name).join(' · '), p.profile_path);
    }
    if (companies.length) {
      h += MT.ui.groupHead('Studios');
      for (const c of companies) h += row('Studio', 'company', c.id, c.name, c.origin_country || '', null);
    }
    return h;
  }

  function card(f) {
    return `<div class="card">
      ${MT.ui.poster({ title: f.name, images: { posterPath: f.imagePath } }, { size: MT.IMG.profile.md })}
      <div class="ct">${esc(f.name)}</div>
      <div class="cs">
        <span>${(f.knownWorkIds || []).length} known</span>
        <button class="btn btn--sm btn--ghost" data-unfollow="${esc(f.id)}">Unfollow</button>
      </div>
    </div>`;
  }

  async function upcoming(follows) {
    const host = document.getElementById('fup');
    if (!host || !MT.config.hasKey('tmdb')) { if (host) host.innerHTML = ''; return; }
    const today = MT.util.todaySortKey();
    const owned = new Set((await MT.repo.allItems()).map(i => i.uid));
    const seen = new Map();

    for (const f of follows.slice(0, 8)) {
      try {
        const credits = f.type === 'company'
          ? { crew: await MT.tmdb.companyReleases(f.sourceId) }
          : await MT.tmdb.personCredits(f.sourceId);
        for (const w of [].concat(credits.cast || [], credits.crew || [])) {
          const kind = w.media_type === 'tv' ? 'tv' : 'movie';
          const uid = MT.normalize.uidOf(kind, 'tmdb', w.id);
          if (owned.has(uid) || seen.has(uid)) continue;
          const stub = MT.normalize.stubFromTmdbSearch(Object.assign({ media_type: kind }, w));
          /* Undated projects are the entire point of this screen, so they are
             kept rather than filtered out for lacking a date. */
          const undated = stub.release.sortKey >= MT.util.SK_UNKNOWN;
          if (!undated && stub.release.sortKey < today) continue;
          stub._via = f.name;
          seen.set(uid, stub);
        }
      } catch (_) { /* one bad follow must not empty the screen */ }
    }

    const items = [...seen.values()].sort((a, b) => a.release.sortKey - b.release.sortKey).slice(0, 18);
    host.innerHTML = items.length ? `<div class="grid">${items.map(s => `
      <div class="card" data-gadd="${esc(s.uid)}">
        ${MT.ui.poster(s)}
        <div class="ct">${esc(s.title)}</div>
        <div class="cs">${MT.ui.waterline(s.release)}<span class="mono">${esc(MT.ui.shortWhen(s.release))}</span></div>
        <div class="why-line">via <b>${esc(s._via)}</b></div>
      </div>`).join('')}</div>`
      : MT.ui.emptyState({ title: 'Nothing upcoming', body: 'No unreleased projects from these follows right now.' });

    host.onclick = async e => {
      const c = e.target.closest('[data-gadd]');
      if (!c) return;
      const stub = seen.get(c.dataset.gadd);
      if (stub) { delete stub._via; await MT.ui.addItem(stub, { source: 'follow_alert' }); MT.inspector.show(stub.uid); }
    };
  }

  return { render };
})();
