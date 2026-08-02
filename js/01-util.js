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

  /* ── Relevance ─────────────────────────────────────────────────────────
     Providers rank by their own popularity metric, and those metrics are not
     comparable across sources: TMDB popularity for "Practical Magic" is 7.9
     while RAWG's `added` for "Magic: The Gathering" is 226. Feeding both into
     one sort put every game above every film. Worse, RAWG's search matches any
     token, so "practical magic" returns half a dozen games with no "practical"
     in them at all.

     So relevance is computed here, from the query and the title, and the
     provider's popularity is demoted to a tiebreak within a band. */

  function normalizeTitle(s) {
    if (!s) return '';
    let t = String(s).toLowerCase();
    try { t = t.normalize('NFD').replace(/[̀-ͯ]/g, ''); } catch (_) {}
    return t.replace(/[^a-z0-9]+/g, ' ').trim();
  }

  /* Returns { score 0..1, coverage 0..1 }. Coverage is the share of query
     words present in the title, and is what the caller filters on — score
     additionally rewards contiguity and word order. */
  function relevance(query, title) {
    const q = normalizeTitle(query);
    const t = normalizeTitle(title);
    if (!q || !t) return { score: 0, coverage: 0 };

    const qs = q.split(' ').filter(Boolean);
    const ts = t.split(' ').filter(Boolean);
    if (!qs.length) return { score: 0, coverage: 0 };

    let matched = 0;
    for (const w of qs) {
      /* A whole word, or a prefix of one — so "prac" still finds "practical"
         while the user is still typing. */
      if (ts.some(x => x === w || x.startsWith(w))) matched++;
    }
    const coverage = matched / qs.length;

    let score;
    if (t === q) score = 1;
    else if (t.startsWith(q)) score = 0.94;
    else if (t.includes(q)) score = 0.86;
    else score = 0.7 * coverage;

    /* A short query matching a very long title is a weaker signal than the
       same query matching a title its own length. */
    if (score < 0.86 && ts.length > qs.length) {
      score *= Math.max(0.55, qs.length / ts.length) ** 0.35;
    }
    return { score, coverage };
  }

  /* Rank a mixed result set by relevance, using each provider's own popularity
     only to break ties WITHIN a relevance band — never across bands.

     The filter is adaptive: for a multi-word query, insist every word appears,
     which is what stops "Magic: The Gathering" answering "practical magic".
     If that leaves too little, relax rather than show an empty screen. */
  function rankByRelevance(query, rows, opts) {
    opts = opts || {};
    const scored = rows.map(r => {
      const best = [r.title, r.originalTitle]
        .filter(Boolean)
        .map(t => relevance(query, t))
        .sort((a, b) => b.score - a.score)[0] || { score: 0, coverage: 0 };
      return Object.assign({}, r, { _score: best.score, _coverage: best.coverage });
    });

    const multiWord = normalizeTitle(query).split(' ').filter(Boolean).length > 1;
    let kept = scored.filter(r => r._coverage >= (multiWord ? 1 : 0.5));
    /* Relax ONLY when nothing matched every word. Padding a good result set
       with partial matches is what produced the original complaint: two solid
       hits for "practical magic" followed by games that merely contain
       "magic". If something matches all of it, that is the answer. */
    if (!kept.length) kept = scored.filter(r => r._coverage >= 0.5);
    if (!kept.length) kept = scored.filter(r => r._score > 0);

    /* Banded at 0.05 so popularity can order near-equal matches while a
       genuinely better title match still wins. One decimal was too coarse: it
       collapsed "starts with the query" (0.94) and "contains it somewhere"
       (0.86) into the same band, so popularity decided — and for the query
       "magic", "Practical Magic" beat "Magic: The Gathering". */
    kept.sort((a, b) => {
      const band = Math.round(b._score * 20) - Math.round(a._score * 20);
      if (band) return band;
      return (b.pop || 0) - (a.pop || 0);
    });
    return kept;
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

  /* ── Release windows ───────────────────────────────────────────────────
     Ranges for the Releases view. Every boundary is computed on sort keys and
     the numeric Date constructor, never by parsing a date string — the whole
     point of the precision model is that we never let a timezone move a day.

     "This week" runs from today for seven days rather than snapping to a
     Monday: someone asking on a Saturday what lands "this week" means the next
     several days, not the two remaining ones. */
  function skToISO(sk) {
    const p = sortKeyToParts(sk);
    if (!p) return null;
    return `${p.y}-${String(p.m).padStart(2, '0')}-${String(p.d).padStart(2, '0')}`;
  }

  function lastDayOfMonth(y, m) {
    return new Date(y, m, 0).getDate();          // day 0 of next month = last of this
  }

  function endOfMonthSortKey(y, m) {
    return y * 10000 + m * 100 + lastDayOfMonth(y, m);
  }

  function monthsAhead(y, m, n) {
    const total = (y * 12 + (m - 1)) + n;
    return { y: Math.floor(total / 12), m: (total % 12) + 1 };
  }

  const RELEASE_RANGES = [
    { id: 'week',   label: 'This week' },
    { id: 'month',  label: 'This month' },
    { id: 'next',   label: 'Next month' },
    { id: 'q',      label: 'Next 3 months' },
    { id: 'half',   label: 'Next 6 months' },
    { id: 'year',   label: 'Rest of this year' },
    { id: 'nextyr', label: 'Next year' },
  ];

  /* Returns { from, to } as inclusive sort keys. */
  function releaseWindow(id) {
    const today = todaySortKey();
    const t = sortKeyToParts(today);
    switch (id) {
      case 'week':
        return { from: today, to: addDaysToSortKey(today, 6) };
      case 'month':
        return { from: today, to: endOfMonthSortKey(t.y, t.m) };
      case 'next': {
        const n = monthsAhead(t.y, t.m, 1);
        return { from: n.y * 10000 + n.m * 100 + 1, to: endOfMonthSortKey(n.y, n.m) };
      }
      case 'q': {
        const n = monthsAhead(t.y, t.m, 3);
        return { from: today, to: endOfMonthSortKey(n.y, n.m) };
      }
      case 'half': {
        const n = monthsAhead(t.y, t.m, 6);
        return { from: today, to: endOfMonthSortKey(n.y, n.m) };
      }
      case 'year':
        return { from: today, to: t.y * 10000 + 1231 };
      case 'nextyr':
        return { from: (t.y + 1) * 10000 + 101, to: (t.y + 1) * 10000 + 1231 };
      default:
        return { from: today, to: addDaysToSortKey(today, 6) };
    }
  }

  return {
    SK_UNKNOWN, SK_TBA, MONTHS, MONTHS_ABBR,
    skToISO, lastDayOfMonth, endOfMonthSortKey, monthsAhead,
    RELEASE_RANGES, releaseWindow,
    parseNaive, sortKeyOf, sortKeyToParts, todaySortKey,
    addDaysToSortKey, daysBetweenSortKeys, daysUntil,
    derivePrecision, quarterOf, displayRelease, shortDate,
    relativeDays, timeAgo, dayLabel,
    escapeHtml, sortTitleOf, truncate, pluralize, formatVotes, runtimeStr,
    normalizeTitle, relevance, rankByRelevance,
    fnv1a, debounce, sleep, deepGet, uniqBy, clamp, bytesStr,
    todayStamp, monthStamp,
  };
})();
