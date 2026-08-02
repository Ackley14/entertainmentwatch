/* ══════════════════════════════════════════════════════════════════════════
   Sync — the encrypted library file living in this repository.

   Read path is unauthenticated: the file is public, and it is ciphertext, so
   nothing is protected by hiding it. On a hosted copy it is fetched relatively;
   on file:// a relative fetch is blocked by the browser, so it falls back to
   raw.githubusercontent.com, which does send `Access-Control-Allow-Origin: *`.

   Write path needs a GitHub fine-grained token with Contents: read+write,
   pasted once per device and kept in localStorage. Verified live: a preflight
   OPTIONS to api.github.com for a cross-origin PUT with an Authorization
   header returns 204 with a wildcard ACAO, so this genuinely works from a
   browser with no proxy.

   A caveat worth knowing, since the token can write to the repo that serves
   this page: anyone who obtained it could commit JavaScript into the site
   itself. For a personal tool that is an acceptable risk, but it is why the
   token is scoped to one repository and given an expiry.
   ══════════════════════════════════════════════════════════════════════════ */

MT.cloud = (function () {
  const LS_TOKEN = 'mt.gh.token.v1';
  const LS_REPO = 'mt.gh.repo.v1';
  const DEFAULT_PATH = 'data/library.enc.json';

  /* Infer owner/repo from the Pages URL so a hosted copy needs no setup at
     all. `ackley14.github.io/entertainmentwatch/` → `Ackley14/entertainmentwatch`.
     Case is preserved from the stored value when one exists, because GitHub
     paths are case-sensitive even though hostnames are not. */
  function inferRepo() {
    const stored = localStorage.getItem(LS_REPO);
    if (stored) return stored;
    const m = /^([^.]+)\.github\.io$/i.exec(location.hostname);
    if (m) {
      const seg = location.pathname.split('/').filter(Boolean)[0];
      if (seg) return `${m[1]}/${seg}`;
      return `${m[1]}/${m[1]}.github.io`;
    }
    return '';
  }

  const repo = () => inferRepo();
  const setRepo = v => { localStorage.setItem(LS_REPO, (v || '').trim()); };
  const token = () => { try { return localStorage.getItem(LS_TOKEN) || ''; } catch (_) { return ''; } };
  const setToken = v => { try { localStorage.setItem(LS_TOKEN, (v || '').trim()); } catch (_) {} };
  const hasToken = () => !!token();
  const path = () => DEFAULT_PATH;

  function configured() { return !!repo(); }

  /* ── Read ──────────────────────────────────────────────────────────────
     Deliberately unauthenticated and cache-busted. `cache: 'no-cache'` forces
     revalidation via ETag rather than re-downloading — appending ?v=Date.now()
     would defeat the 304 path and re-fetch the whole file every time. */
  async function pullEnvelope() {
    const r = repo();
    if (!r) throw new Error('No repository configured.');

    const urls = [];
    if (location.protocol !== 'file:') urls.push(path());          // relative, same origin
    urls.push(`https://raw.githubusercontent.com/${r}/main/${path()}`);
    urls.push(`https://raw.githubusercontent.com/${r}/master/${path()}`);

    let lastErr = null;
    for (const u of urls) {
      try {
        const res = await fetch(u, { cache: 'no-cache', credentials: 'omit' });
        if (res.status === 404) { lastErr = new Error('notfound'); continue; }
        if (!res.ok) { lastErr = new Error(`HTTP ${res.status}`); continue; }
        const body = await res.json();
        if (body && body.kind === 'movietrak.encrypted') return body;
        lastErr = new Error('That file is not an encrypted MovieTrak library.');
      } catch (e) { lastErr = e; }
    }
    if (lastErr && lastErr.message === 'notfound') return null;    // nothing published yet
    throw lastErr || new Error('Could not read the library file.');
  }

  /* ── Write ─────────────────────────────────────────────────────────── */

  function ghHeaders() {
    return {
      'Authorization': `Bearer ${tokenForWrite()}`,
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Content-Type': 'application/json',
    };
  }

  /* The Contents API needs the CURRENT blob sha to replace a file. Cache it
     from the previous write rather than re-reading before every save. */
  async function currentSha() {
    const cached = await MT.repo.metaGet('cloud.sha');
    if (cached) return cached;
    const r = repo();
    const res = await fetch(`https://api.github.com/repos/${r}/contents/${path()}`, {
      headers: ghHeaders(), cache: 'no-store', credentials: 'omit',
    });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(await ghError(res));
    const body = await res.json();
    await MT.repo.metaSet('cloud.sha', body.sha);
    return body.sha;
  }

  async function ghError(res) {
    let msg = `GitHub returned HTTP ${res.status}`;
    try {
      const b = await res.json();
      if (b && b.message) msg = b.message;
      if (res.status === 401) msg = 'That GitHub token was rejected. It may have expired.';
      if (res.status === 403) msg = 'GitHub refused the write. Check the token has Contents: read and write on this repository.';
      if (res.status === 404) msg = 'Repository or path not found. Check the owner/repo value, and that the token can see it.';
    } catch (_) {}
    return msg;
  }

  async function push(envelope, opts) {
    opts = opts || {};
    if (!hasWriteToken()) throw new Error('No GitHub token available. Add one in Settings so changes can be saved back.');
    const r = repo();
    if (!r) throw new Error('No repository configured.');

    const json = JSON.stringify(envelope, null, 1);
    /* The Contents API wants base64. Everything in the envelope is already
       ASCII base64, but encoding through TextEncoder keeps this correct even
       if that ever stops being true. */
    const content = MT.crypto.bytesToB64(new TextEncoder().encode(json));

    let sha = opts.sha !== undefined ? opts.sha : await currentSha();
    let attempt = 0;

    for (;;) {
      const res = await fetch(`https://api.github.com/repos/${r}/contents/${path()}`, {
        method: 'PUT',
        headers: ghHeaders(),
        credentials: 'omit',                 // wildcard ACAO forbids credentials
        body: JSON.stringify({
          message: opts.message || `MovieTrak: sync library (${new Date().toISOString().slice(0, 16).replace('T', ' ')})`,
          content,
          sha: sha || undefined,             // omitted entirely when creating
        }),
      });

      if (res.ok) {
        const body = await res.json();
        await MT.repo.metaSet('cloud.sha', body.content && body.content.sha);
        await MT.repo.metaSet('cloud.lastPushAt', Date.now());
        return body;
      }

      /* 409 usually means our cached sha went stale — another device wrote.
         It can also come from ordinary API-side contention on rapid writes,
         so retries are bounded rather than infinite. */
      if (res.status === 409 && attempt < 2) {
        attempt++;
        await MT.repo.metaSet('cloud.sha', null);
        sha = await currentSha();
        await MT.util.sleep(400 * attempt);
        continue;
      }
      throw new Error(await ghError(res));
    }
  }

  /* ── High-level operations ─────────────────────────────────────────── */

  /* ── The vault ─────────────────────────────────────────────────────────
     The GitHub token lives INSIDE the encrypted payload rather than in each
     browser's localStorage. That is what makes "sign in anywhere with just a
     passcode" true: reading the file needs nothing, decrypting it needs the
     passcode, and decrypting it also hands you the token needed to write back.

     The trade is real and worth being clear about: the token's safety now
     rests entirely on passphrase strength against an offline attack on a file
     anyone can download. Hence the strength requirement at setup, a narrowly
     scoped token, and an expiry date. */
  let vaultToken = null;
  function tokenForWrite() { return vaultToken || token(); }
  function setVaultToken(t) { vaultToken = (t || '').trim() || null; }
  const hasWriteToken = () => !!tokenForWrite();

  async function publish(opts) {
    opts = opts || {};
    if (!MT.crypto.isUnlocked()) throw new Error('Locked — enter your passphrase first.');

    /* One shared dataset means two devices can genuinely collide. Rather than
       silently overwriting, check whether the file moved under us and let the
       caller decide. */
    if (!opts.force) {
      const c = await checkConflict();
      if (c.conflict) {
        const err = new Error('Another device saved changes since this one loaded the library.');
        err.kind = 'conflict';
        err.envelope = c.envelope;
        throw err;
      }
    }
    const doc = await MT.repo.exportAll();
    doc.vault = { githubToken: tokenForWrite() || null };
    const envelope = await MT.crypto.encryptJson(doc);
    const res = await push(envelope, opts);
    await MT.repo.metaSet('cloud.lastSyncedCounts', doc.counts);
    await MT.repo.metaSet('cloud.lastPushAt', Date.now());
    return { counts: doc.counts, commit: res.commit && res.commit.sha };
  }

  /* Replace-only. Merging two divergent libraries is a genuine
     distributed-systems problem, and guessing at it silently would be worse
     than making the choice explicit — see checkConflict below. */
  async function restore(envelope) {
    const doc = await MT.crypto.decryptJson(envelope);
    if (doc.vault && doc.vault.githubToken) setVaultToken(doc.vault.githubToken);
    const counts = await MT.repo.importAll(doc);
    await MT.repo.metaSet('cloud.lastPullAt', Date.now());
    await MT.repo.metaSet('cloud.knownRemoteAt', envelope.updatedAt || null);
    return counts;
  }

  /* Before overwriting the shared file, check nobody else has written since we
     last read it. updatedAt sits outside the ciphertext precisely so this can
     be answered without the passphrase. */
  async function checkConflict() {
    try {
      const env = await pullEnvelope();
      if (!env) return { conflict: false };
      const known = await MT.repo.metaGet('cloud.knownRemoteAt');
      if (!known || !env.updatedAt || env.updatedAt === known) return { conflict: false, envelope: env };
      return { conflict: true, envelope: env, theirs: env.updatedAt, ours: known };
    } catch (_) { return { conflict: false }; }
  }

  /* ── Change the passphrase ─────────────────────────────────────────────
     Order matters and is the whole safety story: derive the new key, encrypt
     with it, PUBLISH, and only swap the live key once GitHub has accepted the
     write. If anything fails the old passphrase still works and nothing has
     been lost. A new salt is generated too, so the old passphrase cannot open
     the new file.

     Other devices that chose "stay signed in" hold the old derived key. Their
     next load fails to decrypt, which drops them at the sign-in screen — which
     is exactly what changing a passphrase should do. */
  async function changePassphrase(newPassphrase) {
    if (!MT.crypto.isUnlocked()) throw new Error('Sign in first.');
    if (!hasWriteToken()) throw new Error('No GitHub token, so the re-encrypted library could not be saved.');

    const doc = await MT.repo.exportAll();
    doc.vault = { githubToken: tokenForWrite() || null };

    const { key, salt } = await MT.crypto.deriveStandalone(newPassphrase);
    const envelope = await MT.crypto.encryptWithKey(key, salt, doc);

    await MT.repo.metaSet('cloud.sha', null);       // force a fresh sha read
    await push(envelope, { message: 'MovieTrak: change passphrase' });

    MT.crypto.adopt(key, salt);                     // only now
    await MT.repo.metaSet('cloud.knownRemoteAt', envelope.updatedAt);
    if (MT.crypto.isRemembered()) await MT.crypto.rememberOnDevice();
    return true;
  }

  /* Pull the shared library and adopt it. This is the normal path on every
     load, because the repo — not this browser — is the source of truth. */
  async function syncDown() {
    const env = await pullEnvelope();
    if (!env) return { exists: false };
    const counts = await restore(env);
    return { exists: true, counts };
  }

  /* Metadata readable WITHOUT the passphrase — updatedAt and counts live
     outside the ciphertext precisely so the unlock screen can say what it is
     about to restore. */
  async function peek() {
    try {
      const env = await pullEnvelope();
      if (!env) return { exists: false };
      return {
        exists: true,
        updatedAt: env.updatedAt,
        counts: env.counts || null,
        salt: MT.crypto.saltFromEnvelope(env),
        envelope: env,
      };
    } catch (e) {
      return { exists: false, error: e.message };
    }
  }

  async function status() {
    return {
      repo: repo(),
      path: path(),
      hasToken: hasWriteToken(),
      tokenFromVault: !!vaultToken,
      unlocked: MT.crypto.isUnlocked(),
      lastPushAt: await MT.repo.metaGet('cloud.lastPushAt'),
      lastPullAt: await MT.repo.metaGet('cloud.lastPullAt'),
    };
  }

  async function verifyToken() {
    if (!hasWriteToken()) return { ok: false, reason: 'No token set.' };
    const r = repo();
    if (!r) return { ok: false, reason: 'No repository set.' };
    try {
      const res = await fetch(`https://api.github.com/repos/${r}`, {
        headers: ghHeaders(), cache: 'no-store', credentials: 'omit',
      });
      if (!res.ok) return { ok: false, reason: await ghError(res) };
      const body = await res.json();
      if (!body.permissions || !body.permissions.push) {
        return { ok: false, reason: 'That token can read this repository but not write to it. It needs Contents: read and write.' };
      }
      return { ok: true, reason: `Can write to ${body.full_name}.` };
    } catch (e) {
      return { ok: false, reason: 'Could not reach GitHub.' };
    }
  }

  function clearToken() {
    try { localStorage.removeItem(LS_TOKEN); } catch (_) {}
    MT.repo.metaSet('cloud.sha', null);
  }

  return {
    repo, setRepo, token, setToken, hasToken, clearToken, path, configured,
    tokenForWrite, setVaultToken, hasWriteToken,
    pullEnvelope, push, publish, restore, syncDown, checkConflict, changePassphrase,
    peek, status, verifyToken,
  };
})();
