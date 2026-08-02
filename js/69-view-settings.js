/* ══════════════════════════════════════════════════════════════════════════
   #/settings — keys, backup, region, diagnostics.
   ══════════════════════════════════════════════════════════════════════════ */

MT.viewSettings = (function () {
  const esc = MT.util.escapeHtml;

  const KEYS = [
    { id: 'tmdb', label: 'TMDB', required: true,
      help: 'Powers all film and television search, metadata and recommendations. Free, no card.',
      link: 'https://www.themoviedb.org/settings/api', linkLabel: 'Get a TMDB key' },
    { id: 'omdb', label: 'OMDb', required: false,
      help: 'Adds IMDb, Rotten Tomatoes and Metacritic scores. Free tier is 1,000 lookups per day.',
      link: 'https://www.omdbapi.com/apikey.aspx', linkLabel: 'Get an OMDb key' },
    { id: 'rawg', label: 'RAWG', required: false,
      help: 'Adds video games. Free tier is 20,000 requests per month.',
      link: 'https://rawg.io/apidocs', linkLabel: 'Get a RAWG key' },
  ];

  async function render() {
    const view = document.getElementById('view');
    const counts = {
      items: await MT.repo.countItems(),
      cache: await MT.repo.cacheCount(),
    };
    const backup = await MT.sync.backupCheck();
    const sync = await MT.cloud.status();
    const onGithubIo = /\.github\.io$/i.test(location.hostname);
    const budgets = {};
    for (const s of ['rawg', 'omdb']) budgets[s] = await MT.net.budgetState(s);

    view.innerHTML = `
      <div class="settings">
        <div class="pagehead"><div><h1>Settings</h1></div></div>

        ${MT.db.isFallback() ? `<div class="warnbox">
          <strong>Limited storage mode</strong>
          This browser is blocking IndexedDB, so MovieTrak is using a much smaller localStorage store.
          Export often — this mode is not reliable for a large library.
        </div>` : ''}

        <section class="section">
          ${MT.ui.groupHead('API keys')}
          <div class="warnbox">
            <strong>Keys live in this browser only</strong>
            Anything you paste here is stored locally and takes precedence over whatever is committed
            in the repository. It is never included in exports.
            ${onGithubIo ? '<br><br><b>Note:</b> every site you host on <span class="num">' + esc(location.hostname) + '</span> shares one browser origin, so any other page you publish there can read these keys and this library. A custom domain is the only way to isolate them.' : ''}
          </div>
          ${KEYS.map(k => keyField(k)).join('')}
        </section>

        <section class="section">
          ${MT.ui.groupHead('Your data')}
          <div class="warnbox">
            <strong>There is no server</strong>
            Everything is stored in this browser. Clearing site data erases it, and Safari deletes local
            storage for sites you have not visited in seven days. Export is the only backup.
            ${backup ? `<br><br>Last export: <b>${backup.last ? MT.util.timeAgo(backup.last) : 'never'}</b>${backup.overdue ? ' — overdue' : ''}.` : ''}
          </div>
          <p style="display:flex;gap:var(--mt-space-2);flex-wrap:wrap">
            <button class="btn btn--primary" id="export">Export library (${counts.items})</button>
            <button class="btn" id="import-btn">Import from file…</button>
            <input type="file" id="import" accept="application/json,.json" hidden>
          </p>
          <p class="field__help" style="margin-top:var(--mt-space-3)">
            Import <b>replaces</b> everything currently stored. Export first if you are unsure.
            The file also carries your alert history, so importing onto a new browser will not
            re-announce every change you have already seen.
          </p>
        </section>

        <section class="section">
          ${MT.ui.groupHead('Sync across machines')}
          ${syncBlock(sync)}
        </section>

        <section class="section">
          ${MT.ui.groupHead('Region & content')}
          <div class="field">
            <label class="field__label" for="region">Region</label>
            <div class="field__help">Decides which release dates, certifications and streaming services you see.</div>
            <input id="region" type="text" maxlength="2" value="${esc(MT.config.get('region'))}"
                   style="max-width:100px;text-transform:uppercase">
          </div>
          <div class="field">
            <label class="field__label">
              <input type="checkbox" id="adult" ${MT.config.get('includeAdult') ? 'checked' : ''}>
              Include adult titles in search
            </label>
          </div>
        </section>

        <section class="section">
          ${MT.ui.groupHead('Diagnostics')}
          <div class="deck">
            <dl>
              <dt>Storage engine</dt><dd>${MT.db.isFallback() ? 'localStorage (fallback)' : 'IndexedDB'}</dd>
              <dt>Titles</dt><dd>${counts.items}</dd>
              <dt>Cached responses</dt><dd>${counts.cache}</dd>
              <dt>Origin</dt><dd>${esc(location.protocol === 'file:' ? 'file:// (local copy)' : location.origin)}</dd>
            </dl>
            ${['rawg', 'omdb'].filter(s => budgets[s]).map(s => `
              <div style="margin-top:var(--mt-space-3)">
                <div class="field__help">${s.toUpperCase()} requests from this browser this ${budgets[s].period}:
                  <span class="num">${budgets[s].used} / ${budgets[s].cap}</span></div>
                <div class="gauge"><div class="${budgets[s].used / budgets[s].cap > 0.8 ? 'hot' : ''}"
                  style="width:${Math.min(100, Math.round(budgets[s].used / budgets[s].cap * 100))}%"></div></div>
              </div>`).join('')}
            <p class="field__help" style="margin-top:var(--mt-space-3)">
              These count only what this browser has asked for. Because the committed keys are shared by
              anyone using this copy of MovieTrak, the real quota may be lower than shown.
            </p>
          </div>
          <p style="margin-top:var(--mt-space-4);display:flex;gap:var(--mt-space-2);flex-wrap:wrap">
            <button class="btn" id="clear-cache">Clear cached responses</button>
            <button class="btn btn--danger" id="wipe">Erase everything</button>
          </p>
        </section>

        <section class="section">
          ${MT.ui.groupHead('About')}
          <div class="prose" style="font-size:var(--mt-fs-sm)">
            <p>MovieTrak is a personal, non-commercial tool. It stores everything locally and has no server.</p>
            <p>It does <b>not</b> search IMDb — IMDb has no free API and blocks browser access to its data
            exports, so search is powered by TMDB. Every result carries its IMDb id, which is how the IMDb
            rating and the link to IMDb work.</p>
            <p>There is no ticketing integration. Alerts about booking windows are inferred from release-date
            precision, not from any cinema chain.</p>
            <p>Data from TMDB, JustWatch, OMDb, RAWG and AniList. TMDB, OMDb and the RAWG free tier are all
            non-commercial-use only.</p>
          </div>
        </section>
      </div>`;

    wire();
  }

  /* The encrypted-library block. The passphrase is never shown, stored, or
     checked against anything — it derives the key, and the file either
     decrypts or it doesn't. */
  function syncBlock(sync) {
    return `
      <p class="field__help" style="margin-bottom:var(--mt-space-4);max-width:70ch">
        Your library is encrypted in this browser and committed to your repository as
        <span class="num">${esc(sync.path)}</span>. Enter the same passphrase on any other machine to load it.
        The passphrase is never stored anywhere — not even as a hash — so there is nothing in the repository
        that could be cracked, and no way to reset it if you forget it.
      </p>

      <div class="deck" style="margin-bottom:var(--mt-space-4)">
        <dl>
          <dt>Status</dt><dd>${sync.unlocked ? 'Unlocked' : 'Locked'}</dd>
          <dt>Repository</dt><dd>${esc(sync.repo || 'not set')}</dd>
          <dt>Last published</dt><dd>${esc(MT.util.timeAgo(sync.lastPushAt))}</dd>
          <dt>Last loaded</dt><dd>${esc(MT.util.timeAgo(sync.lastPullAt))}</dd>
        </dl>
      </div>

      <div class="field">
        <label class="field__label" for="gh-repo">Repository</label>
        <div class="field__help">Owner and name, e.g. <span class="num">Ackley14/entertainmentwatch</span>.
          Detected automatically when the app is served from GitHub Pages.</div>
        <input id="gh-repo" type="text" spellcheck="false" value="${esc(MT.cloud.repo())}"
               placeholder="owner/repository">
      </div>

      <div class="field">
        <label class="field__label" for="gh-token">GitHub token</label>
        <div class="field__help">
          Needed only to <b>publish</b> — reading is public and needs nothing. Create a
          <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">fine-grained token ↗</a>
          scoped to <b>only this repository</b>, with <b>Contents: read and write</b>, and give it an expiry date.
          It is stored in this browser and never leaves it except to talk to GitHub.
        </div>
        <input id="gh-token" type="password" spellcheck="false" autocomplete="off"
               placeholder="${sync.hasToken ? '•••••••• stored in this browser' : 'github_pat_…'}">
        <div class="field__state" id="gh-state">${sync.hasToken ? '● Token stored' : '○ No token — read-only'}</div>
        <p style="margin-top:var(--mt-space-2)">
          <button class="btn btn--sm" id="gh-save">Save &amp; test</button>
          ${sync.hasToken ? '<button class="btn btn--sm btn--ghost" id="gh-clear">Remove token</button>' : ''}
        </p>
      </div>

      <div class="warnbox">
        <strong>One thing to know about the token</strong>
        Because it can write to the repository that serves this page, anyone who got hold of it could also
        commit code into the site. Scope it to this one repository, give it an expiry, and remove it from
        any machine you do not control.
      </div>

      <p style="display:flex;gap:var(--mt-space-2);flex-wrap:wrap">
        ${sync.unlocked
          ? `<button class="btn btn--primary" id="sync-push">Publish now</button>
             <button class="btn" id="sync-pull">Load published copy</button>
             <button class="btn btn--ghost" id="sync-lock">Lock</button>`
          : `<a class="btn btn--primary" href="#/unlock">Unlock / enter passphrase</a>
             <a class="btn" href="#/unlock?mode=setup">Set a passphrase</a>`}
      </p>`;
  }

  function keyField(k) {
    const stored = MT.config.keyIsLocal(k.id);
    const active = MT.config.hasKey(k.id);
    return `<div class="field">
      <label class="field__label" for="key-${k.id}">${k.label}${k.required ? ' <span class="faint">(required)</span>' : ' <span class="faint">(optional)</span>'}</label>
      <div class="field__help">${esc(k.help)} <a href="${k.link}" target="_blank" rel="noopener">${k.linkLabel} ↗</a></div>
      <input id="key-${k.id}" type="text" spellcheck="false" placeholder="${active && !stored ? 'Using the key committed in the repository' : 'Paste your key'}"
             value="${stored ? esc(MT.config.key(k.id)) : ''}">
      <div class="field__state ${active ? 'field__state--ok' : ''}" id="state-${k.id}">
        ${active ? (stored ? '● Using your key' : '● Using the repository key') : '○ Not configured'}
      </div>
      <p style="margin-top:var(--mt-space-2)">
        <button class="btn btn--sm" data-verify="${k.id}">Save &amp; test</button>
        ${stored ? `<button class="btn btn--sm btn--ghost" data-clearkey="${k.id}">Clear</button>` : ''}
      </p>
    </div>`;
  }

  function wire() {
    const view = document.getElementById('view');

    view.addEventListener('click', async e => {
      const v = e.target.closest('[data-verify]');
      const c = e.target.closest('[data-clearkey]');

      if (c) {
        MT.config.setKey(c.dataset.clearkey, '');
        MT.ui.toast('Key cleared');
        MT.router.resolve();
        return;
      }

      if (v) {
        const id = v.dataset.verify;
        const input = document.getElementById('key-' + id);
        const state = document.getElementById('state-' + id);
        const val = input.value.trim();
        if (val) MT.config.setKey(id, val);
        state.textContent = '… testing';
        state.className = 'field__state';
        const client = { tmdb: MT.tmdb, omdb: MT.omdb, rawg: MT.rawg }[id];
        const res = await client.verifyKey(MT.config.key(id));
        state.textContent = res.ok ? '● Working' : '✕ ' + res.reason;
        state.className = 'field__state ' + (res.ok ? 'field__state--ok' : 'field__state--bad');
        if (res.ok) MT.ui.toast(`${id.toUpperCase()} key works`);
      }
    });

    /* ── Sync wiring ─────────────────────────────────────────────────── */
    const repoInput = document.getElementById('gh-repo');
    if (repoInput) repoInput.onchange = () => { MT.cloud.setRepo(repoInput.value); MT.ui.toast('Repository saved'); };

    const ghSave = document.getElementById('gh-save');
    if (ghSave) ghSave.onclick = async () => {
      const t = document.getElementById('gh-token');
      const state = document.getElementById('gh-state');
      if (repoInput) MT.cloud.setRepo(repoInput.value);
      if (t.value.trim()) MT.cloud.setToken(t.value.trim());
      state.textContent = '… testing';
      state.className = 'field__state';
      const res = await MT.cloud.verifyToken();
      state.textContent = (res.ok ? '● ' : '✕ ') + res.reason;
      state.className = 'field__state ' + (res.ok ? 'field__state--ok' : 'field__state--bad');
      t.value = '';
      MT.boot.refreshSyncChip();
    };

    const ghClear = document.getElementById('gh-clear');
    if (ghClear) ghClear.onclick = () => {
      MT.cloud.clearToken();
      MT.ui.toast('Token removed from this browser');
      MT.router.resolve();
    };

    const push = document.getElementById('sync-push');
    if (push) push.onclick = async () => {
      push.disabled = true; push.textContent = 'Publishing…';
      try {
        const res = await MT.cloud.publish();
        MT.ui.toast(`Published ${res.counts.items} titles`);
        MT.router.resolve();
      } catch (e) {
        push.disabled = false; push.textContent = 'Publish now';
        MT.ui.toast(e.message || 'Publish failed', { bad: true });
      }
    };

    const pull = document.getElementById('sync-pull');
    if (pull) pull.onclick = async () => {
      if (!MT.ui.confirmDialog('Loading the published copy replaces everything in this browser. Continue?')) return;
      pull.disabled = true; pull.textContent = 'Loading…';
      try {
        const env = await MT.cloud.pullEnvelope();
        if (!env) { MT.ui.toast('Nothing published yet', { bad: true }); pull.disabled = false; pull.textContent = 'Load published copy'; return; }
        const counts = await MT.cloud.restore(env);
        MT.ui.toast(`Loaded ${counts.items || 0} titles`);
        MT.router.go('#/list');
      } catch (e) {
        pull.disabled = false; pull.textContent = 'Load published copy';
        MT.ui.toast(e.message || 'Load failed', { bad: true });
      }
    };

    const lockBtn = document.getElementById('sync-lock');
    if (lockBtn) lockBtn.onclick = () => {
      MT.crypto.lock();
      MT.ui.toast('Locked — your passphrase will be needed again');
      MT.boot.refreshSyncChip();
      MT.router.resolve();
    };

    document.getElementById('export').onclick = async () => {
      const counts = await MT.sync.exportToFile();
      MT.ui.toast(`Exported ${counts.items} titles`);
      MT.boot.refreshFooter();
    };
    document.getElementById('import-btn').onclick = () => document.getElementById('import').click();
    document.getElementById('import').onchange = async e => {
      const file = e.target.files[0];
      if (!file) return;
      if (!MT.ui.confirmDialog('Importing replaces everything currently stored in this browser. Continue?')) return;
      try {
        const counts = await MT.sync.importFromFile(file);
        MT.ui.toast(`Imported ${counts.items || 0} titles`);
        MT.router.go('#/list');
      } catch (err) {
        MT.ui.toast(err.message || 'Import failed', { bad: true });
      }
    };

    const region = document.getElementById('region');
    region.onchange = () => {
      MT.config.set('region', region.value.toUpperCase().slice(0, 2) || 'US');
      MT.ui.toast('Region saved — refresh a title to pick up new dates');
    };
    document.getElementById('adult').onchange = e => MT.config.set('includeAdult', e.target.checked);

    document.getElementById('clear-cache').onclick = async () => {
      await MT.repo.cacheClear();
      MT.ui.toast('Cache cleared');
      MT.router.resolve();
    };
    document.getElementById('wipe').onclick = async () => {
      if (!MT.ui.confirmDialog('Erase your entire library, follows and history from this browser? This cannot be undone.')) return;
      if (!MT.ui.confirmDialog('Really erase everything? Export first if you might want it back.')) return;
      await MT.repo.wipe();
      MT.ui.toast('Everything erased');
      MT.router.go('#/');
    };
  }

  return { render };
})();
