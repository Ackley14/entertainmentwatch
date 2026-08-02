/* ══════════════════════════════════════════════════════════════════════════
   #/unlock — the sign-in screen.

   It looks like a login and behaves like one, but nothing is being checked
   against a stored secret. The passphrase derives an AES key; if the library
   decrypts, the passphrase was right. There is no "wrong password" branch in
   the code to skip, and no verifier in the repository to attack.
   ══════════════════════════════════════════════════════════════════════════ */

MT.viewUnlock = (function () {
  const esc = MT.util.escapeHtml;

  async function render(params, query) {
    const view = document.getElementById('view');
    const mode = (query && query.mode) || '';

    if (!MT.crypto.available()) {
      view.innerHTML = MT.ui.errorBox('Encryption unavailable',
        'This browser does not expose WebCrypto, which encrypted sync needs. On most browsers this means the page is being served over plain http:// from a non-localhost address.');
      return;
    }

    view.innerHTML = `<div class="firstrun"><h1>Checking for your library…</h1></div>`;
    const remote = await MT.cloud.peek();
    const localCount = await MT.repo.countItems();

    if (mode === 'setup' || (!remote.exists && !MT.crypto.isUnlocked())) {
      return setupScreen(view, remote, localCount);
    }
    return unlockScreen(view, remote, localCount);
  }

  /* ── First time: choose a passphrase ───────────────────────────────── */
  function setupScreen(view, remote, localCount) {
    view.innerHTML = `
      <div class="firstrun">
        <h1>Set a passphrase</h1>
        <p class="lede">
          Your library is encrypted in this browser before it ever leaves it, then committed to
          <span class="num">${esc(MT.cloud.repo() || 'your repository')}</span>. Enter the same passphrase on any
          other machine and everything comes back.
        </p>

        <div class="warnbox">
          <strong>There is no way to reset this</strong>
          The passphrase is never stored, sent, or written down anywhere — not even as a hash. That is what
          makes publishing the file safe, and it also means that if you forget it, the library is gone.
          Keep a copy in your password manager.
        </div>

        <div class="field">
          <label class="field__label" for="pass1">Passphrase</label>
          <div class="field__help">Four unrelated words beat one clever word. The encrypted file will be publicly
            readable, so length is what actually protects it.</div>
          <input id="pass1" type="password" autocomplete="new-password" spellcheck="false"
                 placeholder="correct horse battery staple">
          <div class="field__state" id="strength"></div>
        </div>

        <div class="field">
          <label class="field__label" for="pass2">Confirm</label>
          <input id="pass2" type="password" autocomplete="new-password" spellcheck="false">
          <div class="field__state" id="match"></div>
        </div>

        <div class="field">
          <label class="field__label">
            <input type="checkbox" id="remember"> Stay unlocked on this device
          </label>
          <div class="field__help">Keeps the derived key in this browser so you are not asked every visit.
            Leave it off on a shared machine.</div>
        </div>

        <p style="display:flex;gap:var(--mt-space-2);flex-wrap:wrap;margin-top:var(--mt-space-5)">
          <button class="btn btn--primary" id="do-setup">
            ${localCount ? `Encrypt and publish ${localCount} titles` : 'Set passphrase'}
          </button>
          <a class="btn btn--ghost" href="#/">Skip — keep everything local</a>
        </p>
        <div id="setup-msg" style="margin-top:var(--mt-space-4)"></div>
      </div>`;

    const p1 = document.getElementById('pass1');
    const p2 = document.getElementById('pass2');
    const strength = document.getElementById('strength');
    const match = document.getElementById('match');

    p1.addEventListener('input', () => {
      const s = MT.crypto.strength(p1.value);
      strength.textContent = `${s.label}${s.hint ? ' — ' + s.hint : ''}`;
      strength.className = 'field__state ' + (s.score >= 3 ? 'field__state--ok' : s.score >= 2 ? '' : 'field__state--bad');
    });
    p2.addEventListener('input', () => {
      if (!p2.value) { match.textContent = ''; return; }
      const ok = p1.value === p2.value;
      match.textContent = ok ? '● Matches' : '✕ Does not match';
      match.className = 'field__state ' + (ok ? 'field__state--ok' : 'field__state--bad');
    });

    document.getElementById('do-setup').onclick = async () => {
      const msg = document.getElementById('setup-msg');
      if (p1.value !== p2.value) { msg.innerHTML = MT.ui.errorBox('Not saved', 'The two passphrases do not match.'); return; }
      if (MT.crypto.strength(p1.value).score < 1) {
        msg.innerHTML = MT.ui.errorBox('Too short', 'Use at least eight characters — ideally several words.');
        return;
      }
      const btn = document.getElementById('do-setup');
      btn.disabled = true;
      btn.textContent = 'Deriving key…';      // ~1s at 600k iterations, by design
      msg.innerHTML = '';

      try {
        /* Reuse the existing salt when re-keying an existing library, so an
           old file stays decryptable by the new passphrase only after a
           successful republish. */
        await MT.crypto.unlock(p1.value, remote.exists ? remote.salt : null);
        if (document.getElementById('remember').checked) await MT.crypto.rememberOnDevice();

        if (MT.cloud.hasToken() && MT.cloud.repo()) {
          btn.textContent = 'Publishing…';
          const res = await MT.cloud.publish({ message: 'MovieTrak: initial encrypted library' });
          MT.ui.toast(`Published ${res.counts.items} titles`);
        } else {
          MT.ui.toast('Passphrase set — add a GitHub token in Settings to publish');
        }
        MT.router.go('#/');
      } catch (e) {
        btn.disabled = false;
        btn.textContent = 'Set passphrase';
        msg.innerHTML = MT.ui.errorBox('Could not publish', e.message || String(e));
      }
    };
  }

  /* ── Returning, or a new machine ───────────────────────────────────── */
  function unlockScreen(view, remote, localCount) {
    const when = remote.updatedAt ? MT.util.timeAgo(Date.parse(remote.updatedAt)) : null;
    view.innerHTML = `
      <div class="firstrun">
        <h1>Unlock your library</h1>
        <p class="lede">
          ${remote.exists
            ? `An encrypted library is published in <span class="num">${esc(MT.cloud.repo())}</span>${when ? `, last updated ${esc(when)}` : ''}${remote.counts ? ` — ${remote.counts.items} titles` : ''}.`
            : 'No published library was found for this repository.'}
        </p>

        ${remote.error ? MT.ui.errorBox('Could not reach the library file', remote.error) : ''}

        ${localCount && remote.exists ? `<div class="warnbox">
          <strong>This browser already has ${localCount} titles</strong>
          Unlocking replaces them with the published copy. Export first if this device has anything the
          published library does not.
        </div>` : ''}

        <div class="field">
          <label class="field__label" for="pass">Passphrase</label>
          <input id="pass" type="password" autocomplete="current-password" spellcheck="false" autofocus>
          <div class="field__state" id="msg"></div>
        </div>

        <div class="field">
          <label class="field__label">
            <input type="checkbox" id="remember" ${MT.crypto.isRemembered() ? 'checked' : ''}> Stay unlocked on this device
          </label>
        </div>

        <p style="display:flex;gap:var(--mt-space-2);flex-wrap:wrap;margin-top:var(--mt-space-5)">
          <button class="btn btn--primary" id="do-unlock">Unlock</button>
          <a class="btn btn--ghost" href="#/unlock?mode=setup">Set a new passphrase instead</a>
          <a class="btn btn--ghost" href="#/">Work locally</a>
        </p>

        <p class="faint" style="font-size:var(--mt-fs-micro);margin-top:var(--mt-space-6);max-width:66ch">
          Nothing is being checked against a stored password — there isn’t one. Your passphrase derives the
          key that decrypts the file. If it decrypts, it was right.
        </p>
      </div>`;

    const pass = document.getElementById('pass');
    const msg = document.getElementById('msg');
    const btn = document.getElementById('do-unlock');

    const attempt = async () => {
      if (!pass.value) return;
      btn.disabled = true;
      btn.textContent = 'Deriving key…';
      msg.textContent = '';
      msg.className = 'field__state';
      try {
        await MT.crypto.unlock(pass.value, remote.salt);
        if (remote.exists) {
          btn.textContent = 'Decrypting…';
          const counts = await MT.cloud.restore(remote.envelope);
          if (document.getElementById('remember').checked) await MT.crypto.rememberOnDevice();
          MT.ui.toast(`Unlocked — ${counts.items || 0} titles restored`);
          MT.router.go('#/');
        } else {
          if (document.getElementById('remember').checked) await MT.crypto.rememberOnDevice();
          MT.ui.toast('Unlocked');
          MT.router.go('#/');
        }
      } catch (e) {
        MT.crypto.lock();
        btn.disabled = false;
        btn.textContent = 'Unlock';
        msg.textContent = '✕ ' + (e.message || String(e));
        msg.className = 'field__state field__state--bad';
        pass.select();
      }
    };

    btn.onclick = attempt;
    pass.addEventListener('keydown', e => { if (e.key === 'Enter') attempt(); });
  }

  return { render };
})();
