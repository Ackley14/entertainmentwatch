/* ══════════════════════════════════════════════════════════════════════════
   The gate.

   The repository — not this browser — holds the library. Any device that can
   reach the published file and knows the passphrase gets the same single
   dataset, including the token needed to write changes back. Other people run
   their own copy by forking the repo; there are no user accounts here, because
   one repo is one library.

   Nothing is checked against a stored secret, because there isn't one. The
   passphrase derives an AES-256 key; if the file decrypts, it was right. There
   is no "wrong password" branch to bypass and no verifier in the repo to
   attack — without the key the bytes are noise.
   ══════════════════════════════════════════════════════════════════════════ */

MT.gate = (function () {
  const esc = MT.util.escapeHtml;
  let remote = null;

  const el = () => document.getElementById('gate');

  function show(html) {
    const g = el();
    g.innerHTML = `<div class="gate__panel">${html}</div>`;
    g.hidden = false;
    document.querySelector('.app').setAttribute('aria-hidden', 'true');
  }

  function hide() {
    el().hidden = true;
    document.querySelector('.app').removeAttribute('aria-hidden');
  }

  /* Decides which screen the visitor sees. Called before the app boots. */
  async function open(opts) {
    opts = opts || {};
    if (!MT.crypto.available()) {
      show(`<h1>Encryption unavailable</h1>
        <p class="lede">This browser does not expose WebCrypto, which the shared library needs.
        That usually means the page is being served over plain http:// from something other than
        localhost.</p>
        <button class="btn" id="gWorkLocal">Work locally instead</button>`);
      document.getElementById('gWorkLocal').onclick = workLocal;
      return;
    }

    show(`<h1>Checking for your library…</h1><div class="skel skel--line" style="width:60%"></div>`);
    remote = await MT.cloud.peek();

    if (opts.mode === 'setup' || !remote.exists) return setup();
    return signIn();
  }

  /* ── Returning, or a device that has never seen this library ─────────── */
  function signIn() {
    const when = remote.updatedAt ? MT.util.timeAgo(Date.parse(remote.updatedAt)) : null;
    show(`
      <div class="gate__brand"><b>MovieTrak</b><i>Tide</i></div>
      <h1>Sign in</h1>
      <p class="lede">
        Your library lives in <span class="mono">${esc(MT.cloud.repo())}</span>${
          remote.counts ? ` — <b>${remote.counts.items}</b> titles` : ''}${
          when ? `, last saved ${esc(when)}` : ''}.
        Enter your passphrase to open it on this device.
      </p>

      ${remote.error ? MT.ui.errorBox('Could not reach the library file', remote.error) : ''}

      <div class="field">
        <label class="field__label" for="gpass">Passphrase</label>
        <input id="gpass" type="password" autocomplete="current-password" spellcheck="false" autofocus>
        <div class="field__state" id="gmsg"></div>
      </div>

      <label class="gate__check">
        <input type="checkbox" id="gremember" ${MT.crypto.isRemembered() ? 'checked' : ''}>
        Stay signed in on this device
      </label>

      <div class="actions" style="margin-top:var(--mt-space-5)">
        <button class="btn btn--primary" id="gDo">Open library</button>
        <button class="btn btn--ghost" id="gWorkLocal">Work offline</button>
      </div>

      <p class="gate__note">
        Nothing is being checked against a stored password — there isn’t one. Your passphrase derives
        the key that decrypts the file. If it decrypts, it was right.
      </p>`);

    const pass = document.getElementById('gpass');
    const msg = document.getElementById('gmsg');
    const btn = document.getElementById('gDo');

    const attempt = async () => {
      if (!pass.value) return;
      btn.disabled = true;
      btn.textContent = 'Deriving key…';       // ~0.5–1s at 600k iterations, by design
      msg.textContent = '';
      msg.className = 'field__state';
      try {
        await MT.crypto.unlock(pass.value, remote.salt);
        btn.textContent = 'Decrypting…';
        const counts = await MT.cloud.restore(remote.envelope);
        if (document.getElementById('gremember').checked) await MT.crypto.rememberOnDevice();
        hide();
        await MT.boot.startApp();
        MT.ui.toast(`Signed in — ${counts.items || 0} titles`);
      } catch (e) {
        MT.crypto.lock();
        btn.disabled = false;
        btn.textContent = 'Open library';
        msg.textContent = '✕ ' + (e.message || String(e));
        msg.className = 'field__state field__state--bad';
        pass.select();
      }
    };
    btn.onclick = attempt;
    pass.addEventListener('keydown', e => { if (e.key === 'Enter') attempt(); });
    document.getElementById('gWorkLocal').onclick = workLocal;
  }

  /* ── First run on a fresh repository ─────────────────────────────────── */
  function setup() {
    show(`
      <div class="gate__brand"><b>MovieTrak</b><i>Tide</i></div>
      <h1>Set up your library</h1>
      <p class="lede">
        Your watchlist is encrypted in this browser and saved to
        <span class="mono">${esc(MT.cloud.repo() || 'your repository')}</span>. Sign in with the same
        passphrase on any device and you get the same single library.
      </p>

      <div class="warnbox">
        <strong>There is no way to reset this</strong>
        The passphrase is never stored, sent, or written down anywhere — not even as a hash. That is
        what makes it safe to publish the file, and it also means that if you forget it, the library
        is gone. Put it in your password manager now.
      </div>

      <div class="field">
        <label class="field__label" for="gp1">Passphrase</label>
        <div class="field__help">Four unrelated words beat one clever word. The encrypted file is
          publicly readable and holds your GitHub token, so length is what actually protects it.</div>
        <input id="gp1" type="password" autocomplete="new-password" spellcheck="false"
               placeholder="correct horse battery staple">
        <div class="field__state" id="gstr"></div>
      </div>

      <div class="field">
        <label class="field__label" for="gp2">Confirm</label>
        <input id="gp2" type="password" autocomplete="new-password" spellcheck="false">
        <div class="field__state" id="gmatch"></div>
      </div>

      <div class="field">
        <label class="field__label" for="gtok">GitHub token</label>
        <div class="field__help">
          Needed so changes can be saved back. Create a
          <a href="https://github.com/settings/personal-access-tokens/new" target="_blank" rel="noopener">fine-grained token</a>
          scoped to <b>only this repository</b>, with <b>Contents: read and write</b>, and give it an
          expiry. It is stored inside the encrypted file, so you only enter it once — every other
          device gets it by signing in.
        </div>
        <input id="gtok" type="password" spellcheck="false" autocomplete="off" placeholder="github_pat_…">
        <div class="field__state" id="gtokmsg"></div>
      </div>

      <div class="actions" style="margin-top:var(--mt-space-5)">
        <button class="btn btn--primary" id="gCreate">Create library</button>
        <button class="btn btn--ghost" id="gWorkLocal">Skip — work offline</button>
      </div>
      <div id="gerr" style="margin-top:var(--mt-space-4)"></div>`);

    const p1 = document.getElementById('gp1');
    const p2 = document.getElementById('gp2');
    const str = document.getElementById('gstr');
    const match = document.getElementById('gmatch');

    p1.addEventListener('input', () => {
      const s = MT.crypto.strength(p1.value);
      str.textContent = `${s.label}${s.hint ? ' — ' + s.hint : ''}`;
      str.className = 'field__state ' + (s.score >= 3 ? 'field__state--ok' : s.score >= 2 ? '' : 'field__state--bad');
    });
    p2.addEventListener('input', () => {
      if (!p2.value) { match.textContent = ''; return; }
      const ok = p1.value === p2.value;
      match.textContent = ok ? '● Matches' : '✕ Does not match';
      match.className = 'field__state ' + (ok ? 'field__state--ok' : 'field__state--bad');
    });

    document.getElementById('gCreate').onclick = async () => {
      const err = document.getElementById('gerr');
      const btn = document.getElementById('gCreate');
      const tok = document.getElementById('gtok').value.trim();
      err.innerHTML = '';

      if (p1.value !== p2.value) { err.innerHTML = MT.ui.errorBox('Not saved', 'The two passphrases do not match.'); return; }
      /* Stricter than the local-only version was: this passphrase protects a
         repo-write token inside a world-readable file. */
      if (MT.crypto.strength(p1.value).score < 3) {
        err.innerHTML = MT.ui.errorBox('Too weak',
          'Because the encrypted file is public and contains your GitHub token, this needs to be a real passphrase — four unrelated words, or twenty-plus characters.');
        return;
      }

      btn.disabled = true;
      btn.textContent = 'Deriving key…';
      try {
        await MT.crypto.unlock(p1.value, remote.exists ? remote.salt : null);
        if (tok) {
          btn.textContent = 'Checking token…';
          MT.cloud.setVaultToken(tok);
          const v = await MT.cloud.verifyToken();
          if (!v.ok) {
            MT.cloud.setVaultToken(null);
            btn.disabled = false; btn.textContent = 'Create library';
            err.innerHTML = MT.ui.errorBox('Token rejected', v.reason);
            return;
          }
        }
        if (MT.cloud.hasWriteToken()) {
          btn.textContent = 'Saving…';
          await MT.cloud.publish({ message: 'MovieTrak: create encrypted library' });
        }
        await MT.crypto.rememberOnDevice();
        hide();
        await MT.boot.startApp();
        MT.ui.toast(tok ? 'Library created and saved' : 'Passphrase set — add a token in Settings to save changes');
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Create library';
        err.innerHTML = MT.ui.errorBox('Could not create the library', e.message || String(e));
      }
    };
    document.getElementById('gWorkLocal').onclick = workLocal;
  }

  /* An escape hatch, not a mode. Whatever is done offline stays in this
     browser until the next successful sign-in overwrites it, and the banner
     says so rather than letting it look like everything is fine. */
  async function workLocal() {
    hide();
    await MT.boot.startApp();
    MT.ui.banner('Working offline — changes stay in this browser only and will be replaced the next time you sign in.',
      { actionLabel: 'Sign in', onAction: () => open() });
  }

  function signOut() {
    MT.crypto.lock();
    MT.cloud.setVaultToken(null);
    location.reload();
  }

  return { open, hide, signOut, workLocal };
})();

/* The old #/unlock route now just re-opens the gate, so existing links and
   the tree entry keep working. */
MT.viewUnlock = {
  render(params, query) {
    MT.gate.open({ mode: (query && query.mode) || '' });
    return Promise.resolve();
  },
};
