/**
 * Detect locale / market homepage variants that flood crawls (Stripe /es-us, /ae, …)
 * so we prefer real content routes from the primary site navigation.
 */

/** ISO 639-1 language codes commonly used in URL prefixes. */
const LANG_CODES = new Set([
  'aa', 'ab', 'ae', 'af', 'ak', 'am', 'an', 'ar', 'as', 'av', 'ay', 'az',
  'ba', 'be', 'bg', 'bh', 'bi', 'bm', 'bn', 'bo', 'br', 'bs',
  'ca', 'ce', 'ch', 'co', 'cr', 'cs', 'cu', 'cv', 'cy',
  'da', 'de', 'dv', 'dz',
  'ee', 'el', 'en', 'eo', 'es', 'et', 'eu',
  'fa', 'ff', 'fi', 'fj', 'fo', 'fr', 'fy',
  'ga', 'gd', 'gl', 'gn', 'gu', 'gv',
  'ha', 'he', 'hi', 'ho', 'hr', 'ht', 'hu', 'hy', 'hz',
  'ia', 'id', 'ie', 'ig', 'ii', 'ik', 'io', 'is', 'it', 'iu',
  'ja', 'jv',
  'ka', 'kg', 'ki', 'kj', 'kk', 'kl', 'km', 'kn', 'ko', 'kr', 'ks', 'ku', 'kv', 'kw', 'ky',
  'la', 'lb', 'lg', 'li', 'ln', 'lo', 'lt', 'lu', 'lv',
  'mg', 'mh', 'mi', 'mk', 'ml', 'mn', 'mr', 'ms', 'mt', 'my',
  'na', 'nb', 'nd', 'ne', 'ng', 'nl', 'nn', 'no', 'nr', 'nv', 'ny',
  'oc', 'oj', 'om', 'or', 'os',
  'pa', 'pi', 'pl', 'ps', 'pt',
  'qu',
  'rm', 'rn', 'ro', 'ru', 'rw',
  'sa', 'sc', 'sd', 'se', 'sg', 'si', 'sk', 'sl', 'sm', 'sn', 'so', 'sq', 'sr', 'ss', 'st', 'su', 'sv', 'sw',
  'ta', 'te', 'tg', 'th', 'ti', 'tk', 'tl', 'tn', 'to', 'tr', 'ts', 'tt', 'tw', 'ty',
  'ug', 'uk', 'ur', 'uz',
  've', 'vi', 'vo',
  'wa', 'wo',
  'xh',
  'yi', 'yo',
  'za', 'zh', 'zu',
]);

/** ISO 3166-1 alpha-2 country / region codes used as lone path segments (/ae, /at, /au). */
const REGION_CODES = new Set([
  'ad', 'ae', 'af', 'ag', 'ai', 'al', 'am', 'ao', 'aq', 'ar', 'as', 'at', 'au', 'aw', 'ax', 'az',
  'ba', 'bb', 'bd', 'be', 'bf', 'bg', 'bh', 'bi', 'bj', 'bl', 'bm', 'bn', 'bo', 'bq', 'br', 'bs', 'bt', 'bv', 'bw', 'by', 'bz',
  'ca', 'cc', 'cd', 'cf', 'cg', 'ch', 'ci', 'ck', 'cl', 'cm', 'cn', 'co', 'cr', 'cu', 'cv', 'cw', 'cx', 'cy', 'cz',
  'de', 'dj', 'dk', 'dm', 'do', 'dz',
  'ec', 'ee', 'eg', 'eh', 'er', 'es', 'et',
  'fi', 'fj', 'fk', 'fm', 'fo', 'fr',
  'ga', 'gb', 'gd', 'ge', 'gf', 'gg', 'gh', 'gi', 'gl', 'gm', 'gn', 'gp', 'gq', 'gr', 'gs', 'gt', 'gu', 'gw', 'gy',
  'hk', 'hm', 'hn', 'hr', 'ht', 'hu',
  'id', 'ie', 'il', 'im', 'in', 'io', 'iq', 'ir', 'is', 'it',
  'je', 'jm', 'jo', 'jp',
  'ke', 'kg', 'kh', 'ki', 'km', 'kn', 'kp', 'kr', 'kw', 'ky', 'kz',
  'la', 'lb', 'lc', 'li', 'lk', 'lr', 'ls', 'lt', 'lu', 'lv', 'ly',
  'ma', 'mc', 'md', 'me', 'mf', 'mg', 'mh', 'mk', 'ml', 'mm', 'mn', 'mo', 'mp', 'mq', 'mr', 'ms', 'mt', 'mu', 'mv', 'mw', 'mx', 'my', 'mz',
  'na', 'nc', 'ne', 'nf', 'ng', 'ni', 'nl', 'no', 'np', 'nr', 'nu', 'nz',
  'om',
  'pa', 'pe', 'pf', 'pg', 'ph', 'pk', 'pl', 'pm', 'pn', 'pr', 'ps', 'pt', 'pw', 'py',
  'qa',
  're', 'ro', 'rs', 'ru', 'rw',
  'sa', 'sb', 'sc', 'sd', 'se', 'sg', 'sh', 'si', 'sj', 'sk', 'sl', 'sm', 'sn', 'so', 'sr', 'ss', 'st', 'sv', 'sx', 'sy', 'sz',
  'tc', 'td', 'tf', 'tg', 'th', 'tj', 'tk', 'tl', 'tm', 'tn', 'to', 'tr', 'tt', 'tv', 'tw', 'tz',
  'ua', 'ug', 'um', 'us', 'uy', 'uz',
  'va', 'vc', 've', 'vg', 'vi', 'vn', 'vu',
  'wf', 'ws',
  'ye', 'yt',
  'za', 'zm', 'zw',
]);

/** Short first segments that are product/site routes, not locales. */
const NON_LOCALE_SHORT = new Set([
  'ai', 'api', 'app', 'apps', 'blog', 'cdn', 'css', 'dev', 'docs', 'go', 'help',
  'img', 'jobs', 'js', 'new', 'news', 'pay', 'pro', 'rss', 'shop', 'tax', 'www',
  'web', 'amp', 'cms', 'faq', 'me', 'my', 'id', // 'id' can be Indonesia OR identity — keep if second segment exists
]);

const LOCALE_SEGMENT_RE = /^[a-z]{2}(?:-[a-z]{2,8})?$/i;

export function pathSegments(pathname: string): string[] {
  return String(pathname || '/')
    .split('/')
    .map((s) => s.trim())
    .filter(Boolean);
}

/** True for a single URL segment that looks like `en`, `es-us`, `zh-hans`, `en_GB`. */
export function isLocaleSegment(segment: string): boolean {
  const raw = String(segment || '').trim().toLowerCase().replace(/_/g, '-');
  if (!raw || !LOCALE_SEGMENT_RE.test(raw)) return false;
  if (NON_LOCALE_SHORT.has(raw)) return false;

  const parts = raw.split('-');
  const lang = parts[0];
  if (parts.length === 1) {
    // Lone `/ae`, `/at`, `/au` — country market roots. Skip ambiguous non-region shorts.
    return REGION_CODES.has(lang) || LANG_CODES.has(lang);
  }
  // `en-us`, `nl-be`, `zh-hans`
  if (!LANG_CODES.has(lang)) return false;
  const rest = parts.slice(1).join('-');
  if (parts.length === 2 && (REGION_CODES.has(parts[1]) || parts[1].length >= 4)) return true;
  return rest.length >= 2;
}

/**
 * Path is only a locale/market root: `/`, no — `/es-us`, `/ae`, `/en-be`.
 * Not `/payments`, not `/es-us/payments`.
 */
export function isLocaleOnlyPath(pathname: string): boolean {
  const segs = pathSegments(pathname);
  return segs.length === 1 && isLocaleSegment(segs[0]);
}

/** First segment is a locale prefix: `/es-us/payments`, `/fr/pricing`. */
export function isLocalePrefixedPath(pathname: string): boolean {
  const segs = pathSegments(pathname);
  return segs.length >= 2 && isLocaleSegment(segs[0]);
}

/** Locale root of the start URL, or null when cloning the default (non-locale) site. */
export function startLocalePrefix(startUrl: string): string | null {
  try {
    const segs = pathSegments(new URL(startUrl).pathname);
    if (segs.length >= 1 && isLocaleSegment(segs[0])) return segs[0].toLowerCase();
  } catch {}
  return null;
}

/**
 * Skip locale market variants that are not part of the site we're cloning.
 * - Cloning `https://stripe.com/` → skip `/es-us`, `/ae`, `/fr/payments`
 * - Cloning `https://stripe.com/es-us` → keep `/es-us…`, skip other locales
 */
export function shouldSkipLocaleVariant(url: string, startUrl: string): boolean {
  let path: string;
  try {
    path = new URL(url).pathname || '/';
  } catch {
    return false;
  }

  const startPrefix = startLocalePrefix(startUrl);
  const segs = pathSegments(path);
  if (!segs.length) return false;

  if (!startPrefix) {
    // Default-language clone: never spend budget on other locale roots or prefixed trees.
    return isLocaleOnlyPath(path) || isLocalePrefixedPath(path);
  }

  // Locale-specific clone: only stay inside that locale tree.
  if (!isLocaleSegment(segs[0])) return false;
  return segs[0].toLowerCase() !== startPrefix;
}
