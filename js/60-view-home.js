/* ══════════════════════════════════════════════════════════════════════════
   #/ — home. The marquee, unread activity, and what to pick up next.
   ══════════════════════════════════════════════════════════════════════════ */

MT.viewHome = (function () {
  const esc = MT.util.escapeHtml;

  async function render() {
    const view = document.getElementById('view');
    const all = await MT.repo.allItems();

    if (!all.length) return firstRun(view);

    const today = MT.util.todaySortKey();
    const soon = all
      .filter(it => it.user.status !== 'dropped' && it.user.status !== 'watched')
      .filter(it => it.release.sortKey >= MT.util.addDaysToSortKey(today, -7)
                 && it.release.sortKey < MT.util.SK_UNKNOWN)
      .sort((a, b) => a.release.sortKey - b.release.sortKey)
      .slice(0, 8);

    const watching = all.filter(it => it.user.status === 'watching')
      .sort((a, b) => (b.user.updatedAt || 0) - (a.user.updatedAt || 0)).slice(0, 12);

    const want = all.filter(it => it.user.status === 'want')
      .sort((a, b) => (b.user.priority || 0) - (a.user.priority || 0)
                   || (b.user.addedAt || 0) - (a.user.addedAt || 0)).slice(0, 12);

    const unread = await MT.repo.feedItems({ unreadOnly: true, limit: 4 });

    view.innerHTML = `
      ${soon.length ? `
        <section class="section">
          ${MT.ui.ruleHead('On the marquee', '<a href="#/up">All dates →</a>')}
          <div class="marquee">
            ${soon.map(marqueeRow).join('')}
          </div>
        </section>` : ''}

      ${unread.length ? `
        <section class="section">
          ${MT.ui.ruleHead('Since you were last here', '<a href="#/alerts">Everything →</a>')}
          <div class="feed">${unread.map(alertRow).join('')}</div>
        </section>` : ''}

      ${watching.length ? `
        <section class="section">
          ${MT.ui.ruleHead('Continue')}
          <div class="rail">${watching.map(it => MT.ui.posterCard(it, { hideStatus: true })).join('')}</div>
        </section>` : ''}

      ${want.length ? `
        <section class="section">
          ${MT.ui.ruleHead('Up next', '<a href="#/list">Library →</a>')}
          <div class="rail">${want.map(it => MT.ui.posterCard(it, { hideStatus: true })).join('')}</div>
        </section>` : ''}

      <section class="section">
        ${MT.ui.ruleHead('For you', '<a href="#/recs">More →</a>')}
        <div id="home-recs">${MT.ui.skeletonGrid(6)}</div>
      </section>`;

    loadRecs(all);
  }

  function marqueeRow(it) {
    const days = MT.util.daysUntil(it.release.sortKey);
    const when = it.release.precision === 'day'
      ? `${MT.util.shortDate(it.release.sortKey)}<small>${esc(MT.util.relativeDays(days))}</small>`
      : `${esc(it.release.display)}<small>${esc(it.release.precision)}</small>`;
    return `<a class="marquee__row" href="#/item/${encodeURIComponent(it.uid)}">
      <div class="marquee__when">${when}</div>
      <div>
        <div class="marquee__title">${esc(it.title)}</div>
        <div class="marquee__meta">${esc(MT.alerts.prettyType(it.release.type))}
          ${MT.ui.driftBadge(it.release)}</div>
      </div>
      <div>${MT.ui.statusPill(it.release)}</div>
    </a>`;
  }

  function alertRow(a) {
    return `<a class="alert alert--unread ${a.severity === 'high' ? 'alert--sev-high' : ''}"
               href="#/item/${encodeURIComponent(a.uid || '')}">
      ${a.posterPath
        ? `<img class="alert__art" loading="lazy" src="${esc(MT.tmdb.img(a.posterPath, MT.IMG.poster.sm) || a.posterPath)}" alt="">`
        : '<span class="alert__art"></span>'}
      <div class="alert__body">
        <span class="alert__title">${esc(a.title)}</span>
        ${a.body ? `<div class="muted">${esc(MT.util.truncate(a.body, 110))}</div>` : ''}
      </div>
      <span class="alert__when">${esc(MT.util.timeAgo(a.lastAt))}</span>
    </a>`;
  }

  async function loadRecs(all) {
    const host = document.getElementById('home-recs');
    if (!host) return;
    if (!MT.config.hasKey('tmdb')) { host.innerHTML = ''; return; }
    const seeds = all.filter(it => it.kind !== 'game' && it.rec && it.rec.seedEligible);
    if (seeds.length < 3) {
      host.innerHTML = MT.ui.emptyState({
        title: 'Add a few more titles',
        body: 'Once three or four things are in your library, MovieTrak can build a taste profile and start suggesting.',
      });
      return;
    }
    try {
      const kind = seeds.filter(s => s.kind === 'tv').length > seeds.length / 2 ? 'tv' : 'movie';
      const res = await MT.rec.generate(kind, { slate: 6, hydrate: 24 });
      if (!res.items.length) { host.innerHTML = ''; return; }
      host.innerHTML = '<div class="grid">' + res.items.map(r => `
        <div class="rec">${MT.ui.posterCard(r.item, { hideStatus: true })}
          <div class="rec__why ${r.reason.kind === 'graph' ? 'rec__why--graph' : ''}">${r.reason.text}</div>
        </div>`).join('') + '</div>';
    } catch (e) {
      host.innerHTML = '';
      console.warn('[home] recs failed', e && e.message);
    }
  }

  function firstRun(view) {
    const needsKey = !MT.config.hasKey('tmdb');
    view.innerHTML = `
      <div class="firstrun">
        <h1>MovieTrak</h1>
        <p class="firstrun__lede">One list for the films, television, games and anime you mean to get to —
        with real release dates, ratings from several places, and suggestions built from your own taste.</p>

        ${needsKey ? `
          <div class="warnbox">
            <strong>One thing first</strong>
            MovieTrak needs a free TMDB API key to search. It takes about a minute and no card is required.
          </div>
          <ol>
            <li>Create an account at <a href="https://www.themoviedb.org/signup" target="_blank" rel="noopener">themoviedb.org</a>.</li>
            <li>Open <a href="https://www.themoviedb.org/settings/api" target="_blank" rel="noopener">Settings → API</a> and request an API key (choose “Developer”).</li>
            <li>Copy the <b>API Key (v3 auth)</b> and paste it into MovieTrak’s settings.</li>
          </ol>
          <p style="margin-top:var(--s-5)"><a class="btn btn--primary" href="#/settings">Paste my key →</a></p>
        ` : `
          <ol>
            <li>Press <span class="num">/</span> or click the search box above.</li>
            <li>Type a title — films, television and games are all searched at once.</li>
            <li>Press <span class="num">Enter</span> to add the top result to your list.</li>
          </ol>
          <p style="margin-top:var(--s-5)">
            <button class="btn btn--primary" onclick="document.getElementById('omni').focus()">Search for something</button>
            <a class="btn" href="#/settings">Settings</a>
          </p>
        `}

        <div class="warnbox" style="margin-top:var(--s-7)">
          <strong>Everything is stored in this browser</strong>
          There is no account and no server. That means it is fast and private — and also that clearing site data,
          or Safari’s seven-day idle cleanup, will erase it. Use <b>Export</b> regularly; it is one click.
        </div>
      </div>`;
  }

  return { render };
})();
