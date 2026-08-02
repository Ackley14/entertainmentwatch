/* ══════════════════════════════════════════════════════════════════════════
   Utilities — dates, sort keys, text, hashing.

   The date code here is the most bug-prone part of the whole app, so it is
   isolated and every rule is stated at its call site. Two rules dominate:

     1. NEVER `new Date("2026-03-15")`. That parses as UTC midnight, so it
        renders as March 14 for everyone west of Greenwich. Source dates are
        naive calendar dates in some region — parse them to {y,m,d} and format
        from the triple.

     2. A sortKey is an INTEGER, not a date. 20260831 + 1 is not September 1.
        Any arithmetic must round-trip through real date parsing.
   ══════════════════════════════════════════════════════════════════════════ */

MT.util = (function () {

  /* ── Sort-key sentinels ────────────────────────────────────────────────
     Ordinary dates encode as YYYYMMDD so they sort naturally as ints. The two
     sentinels sort last, keeping undated items at the bottom of every list
     without any special-casing in the comparators. */
  const SK_UNKNOWN = 99999998;
  const SK_TBA     = 99999999;

  const MONTHS = ['January','February','March','April','May','June',
                  'July','August','September','October','November','December'];
  const MONTHS_ABBR = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];

  /* Parse a naive 'YYYY-MM-DD' / 'YYYY-MM' / 'YYYY' string. Returns null for
     anything unusable. Never constructs a Date. */
  function parseNaive(str) {
    if (typeof str !== 'string') return null;
    const s = str.trim();
    if (!s) return null;
    let m;
    if ((m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s))) {
      return { y: +m[1], m: +m[2], d: +m[3] };
    }
    if ((m = /^(\d{4})-(\d{2})$/.exec(s))) return { y: +m[1], m: +m[2], d: null };
    if ((m = /^(\d{4})$/.exec(s)))         return { y: +m[1], m: null, d: null };
    return null;
  }

  function sortKeyOf(parts, precision) {
    if (!parts || !parts.y) return precision === 'tba' ? SK_TBA : SK_UNKNOWN;
    const y = parts.y;
    /* Vaguer precisions anchor to the START of their window so a "July 2027"
       item sorts among early-July items rather than after all of them. */
    const mo = parts.m || 1;
    const d = parts.d || 1;
    return y * 10000 + mo * 100 + d;
  }

  function sortKeyToParts(sk) {
    if (!Number.isFinite(sk) || sk >= SK_UNKNOWN) return null;
    return { y: Math.floor(sk / 10000), m: Math.floor((sk % 10000) / 100), d: sk % 100 };
  }

  /* Local midnight today, as a sort key. Uses the *user's* calendar day, so
     "releases tomorrow" doesn't flip over at 5pm. */
  function todaySortKey() {
    const n = new Date();
    return n.getFullYear() * 10000 + (n.getMonth() + 1) * 100 + n.getDate();
  }

  function addDaysToSortKey(sk, days) {
    const p = sortKeyToParts(sk);
    if (!p) return sk;
    const dt = new Date(p.y, p.m - 1, p.d);          // local constructor, deliberate
    dt.setDate(dt.getDate() + days);
    return dt.getFullYear() * 10000 + (dt.getMonth() + 1) * 100 + dt.getDate();
  }

  function daysBetweenSortKeys(a, b) {
    const pa = sortKeyToParts(a), pb = sortKeyToParts(b);
    if (!pa || !pb) return null;
    const da = Date.UTC(pa.y, pa.m - 1, pa.d);       // UTC on BOTH sides: the offset
    const db = Date.UTC(pb.y, pb.m - 1, pb.d);       // cancels, so DST can't skew it
    return Math.round((db - da) / 86400000);
  }

  /* Days from today until a sort key. Negative = in the past. */
  function daysUntil(sk) { return daysBetweenSortKeys(todaySortKey(), sk); }

  /* ── Precision derivation ──────────────────────────────────────────────
     TMDB stores placeholder dates for films that only have a year committed,
     nearly always Jan 1 or Dec 31. Rendering those as a real day is a lie the
     user will act on, so unreleased Jan-1/Dec-31 dates are demoted to year
     precision and flagged `inferred`. */
  function derivePrecision(raw, opts) {
    opts = opts || {};
    const parts = parseNaive(raw);
    if (!parts) return { precision: opts.tba ? 'tba' : 'unknown', parts: null, inferred: 0 };
    if (parts.m == null) return { precision: 'year', parts, inferred: 0 };
    if (parts.d == null) return { precision: 'month', parts, inferred: 0 };

    /* Checked BEFORE the Jan-1/Dec-31 rule, because the commonest sentinels
       (2099-12-31, 2100-01-01) satisfy both — and "TBA" is the truthful
       reading, not "sometime in 2099". */
    if (parts.y > new Date().getFullYear() + 10) {
      return { precision: 'tba', parts: null, inferred: 1 };
    }
    const isPlaceholder = (parts.m === 1 && parts.d === 1) || (parts.m === 12 && parts.d === 31);
    if (isPlaceholder && opts.released === false) {
      return { precision: 'year', parts: { y: parts.y, m: null, d: null }, inferred: 1 };
    }
    return { precision: 'day', parts, inferred: 0 };
  }

  function quarterOf(month) { return Math.floor((month - 1) / 3) + 1; }

  /* Render-ready string. THE HONESTY RULE: if precision is coarser than a day,
     no day number may appear anywhere in the output. */
  function displayRelease(parts, precision) {
    switch (precision) {
      case 'day':
        if (!parts) return 'TBA';
        return `${MONTHS_ABBR[parts.m - 1]} ${parts.d}, ${parts.y}`;
      case 'month':
        if (!parts) return 'TBA';
        return `${MONTHS[parts.m - 1]} ${parts.y}`;
      case 'quarter':
        if (!parts) return 'TBA';
        return `Q${quarterOf(parts.m)} ${parts.y}`;
      case 'year':
        return parts ? String(parts.y) : 'TBA';
      case 'tba':      return 'TBA';
      default:         return 'No date';
    }
  }

  function shortDate(sk) {
    const p = sortKeyToParts(sk);
    return p ? `${MONTHS_ABBR[p.m - 1]} ${p.d}` : '—';
  }

  function relativeDays(n) {
    if (n == null) return '';
    if (n === 0) return 'today';
    if (n === 1) return 'tomorrow';
    if (n === -1) return 'yesterday';
    if (n < 0) {
      const a = -n;
      if (a < 30) return `${a}d ago`;
      if (a < 365) return `${Math.round(a / 30)}mo ago`;
      return `${(a / 365).toFixed(1)}y ago`;
    }
    if (n < 30) return `in ${n}d`;
    if (n < 365) return `in ${Math.round(n / 30)}mo`;
    return `in ${(n / 365).toFixed(1)}y`;
  }

  function timeAgo(ms) {
    if (!ms) return 'never';
    const s = Math.max(0, Math.round((Date.now() - ms) / 1000));
    if (s < 60) return 'just now';
    if (s < 3600) return `${Math.floor(s / 60)}m ago`;
    if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
    const d = Math.floor(s / 86400);
    return d === 1 ? 'yesterday' : `${d}d ago`;
  }

  function dayLabel(ms) {
    const d = new Date(ms);
    const today = new Date(); today.setHours(0, 0, 0, 0);
    const that = new Date(d); that.setHours(0, 0, 0, 0);
    const diff = Math.round((today - that) / 86400000);
    if (diff === 0) return 'Today';
    if (diff === 1) return 'Yesterday';
    if (diff < 7) return `${diff} days ago`;
    return `${MONTHS_ABBR[d.getMonth()]} ${d.getDate()}, ${d.getFullYear()}`;
  }

  /* ── Text ──────────────────────────────────────────────────────────── */

  function escapeHtml(s) {
    if (s == null) return '';
    return String(s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  /* Sort title: drops a leading article and normalises accents so "Amélie"
     and "The Matrix" land where a human would look for them. */
  function sortTitleOf(title) {
    if (!title) return '';
    let t = String(title).toLowerCase();
    try { t = t.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (_) {}
    t = t.replace(/^(the|a|an|le|la|les|el|los|das|der|die)\s+/, '');
    return t.replace(/[^a-z0-9 ]/g, '').trim();
  }

  function truncate(s, n) {
    if (!s) return '';
    return s.length <= n ? s : s.slice(0, n - 1).trimEnd() + '…';
  }

  function pluralize(n, one, many) {
    return `${n} ${n === 1 ? one : (many || one + 's')}`;
  }

  function formatVotes(n) {
    if (!n) return '';
    if (n >= 1e6) return (n / 1e6).toFixed(1).replace(/\.0$/, '') + 'M';
    if (n >= 1e3) return (n / 1e3).toFixed(n >= 1e4 ? 0 : 1).replace(/\.0$/, '') + 'k';
    return String(n);
  }

  function runtimeStr(min) {
    if (!min) return '';
    const h = Math.floor(min / 60), m = min % 60;
    return h ? `${h}h ${m}m` : `${m}m`;
  }

  /* ── Hashing ───────────────────────────────────────────────────────────
     FNV-1a, 64-bit-ish via two 32-bit lanes. Used for content-addressed alert
     ids and cache keys — it needs to be stable and fast, not cryptographic. */
  function fnv1a(str) {
    let h1 = 0x811c9dc5, h2 = 0x01000193;
    for (let i = 0; i < str.length; i++) {
      const c = str.charCodeAt(i);
      h1 ^= c; h1 = Math.imul(h1, 0x01000193) >>> 0;
      h2 ^= c; h2 = Math.imul(h2 ^ (h2 >>> 7), 0x85ebca6b) >>> 0;
    }
    return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36);
  }

  /* ── Async plumbing ────────────────────────────────────────────────── */

  function debounce(fn, ms) {
    let t;
    const wrapped = function (...a) {
      clearTimeout(t);
      t = setTimeout(() => fn.apply(this, a), ms);
    };
    wrapped.cancel = () => clearTimeout(t);
    return wrapped;
  }

  const sleep = ms => new Promise(r => setTimeout(r, ms));

  function deepGet(obj, path, dflt) {
    const parts = path.split('.');
    let cur = obj;
    for (const p of parts) {
      if (cur == null) return dflt;
      cur = cur[p];
    }
    return cur === undefined ? dflt : cur;
  }

  function uniqBy(arr, keyFn) {
    const seen = new Set(), out = [];
    for (const x of arr) {
      const k = keyFn(x);
      if (seen.has(k)) continue;
      seen.add(k); out.push(x);
    }
    return out;
  }

  function clamp(n, lo, hi) { return Math.min(hi, Math.max(lo, n)); }

  function bytesStr(n) {
    if (n < 1024) return n + ' B';
    if (n < 1048576) return (n / 1024).toFixed(0) + ' KB';
    return (n / 1048576).toFixed(1) + ' MB';
  }

  function todayStamp() {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}-${String(n.getDate()).padStart(2, '0')}`;
  }
  function monthStamp() {
    const n = new Date();
    return `${n.getFullYear()}-${String(n.getMonth() + 1).padStart(2, '0')}`;
  }

  return {
    SK_UNKNOWN, SK_TBA, MONTHS, MONTHS_ABBR,
    parseNaive, sortKeyOf, sortKeyToParts, todaySortKey,
    addDaysToSortKey, daysBetweenSortKeys, daysUntil,
    derivePrecision, quarterOf, displayRelease, shortDate,
    relativeDays, timeAgo, dayLabel,
    escapeHtml, sortTitleOf, truncate, pluralize, formatVotes, runtimeStr,
    fnv1a, debounce, sleep, deepGet, uniqBy, clamp, bytesStr,
    todayStamp, monthStamp,
  };
})();
