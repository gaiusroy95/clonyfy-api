import { createHash } from 'crypto';
import { writeFileSync, mkdirSync, existsSync } from 'fs';
import { join, extname } from 'path';
import mime from 'mime-types';
import type { BrowserContext, Page } from 'playwright';
import type { ArtifactWrittenEvent, AssetEntry, NetworkEntry, PageRecord } from './types.js';
import { logger } from './logger.js';
import { normalizePageUrl } from './pageUrls.js';
import {
  IS_FAST_CLONE,
  reserveServerlessAssetBytes,
  SERVERLESS_ASSET_BUDGET_BYTES,
} from './serverlessBudget.js';
import {
  ensurePlaceholderAsset,
  PLACEHOLDER_IMAGE_BODY,
} from './fallbackAssets.js';
import {
  CAROUSEL_SKIP_SELECTOR,
  domAssetUrlScore,
  normalizeAllMotionStacksInDocument,
} from './carouselFix.js';

/** Hover / expand nav menus so product links (e.g. /payments) appear in the DOM. */
async function revealNavDropdownLinks(page: Page): Promise<void> {
  try {
    // Fast clones: fewer hovers, shorter timeouts — still enough for Stripe mega-menus.
    const maxTriggers = IS_FAST_CLONE ? 18 : 28;
    const hoverTimeout = IS_FAST_CLONE ? 900 : 1200;
    const pauseMs = IS_FAST_CLONE ? 70 : 100;
    const triggers = page.locator(
      'nav button, header button, [role="navigation"] button, [aria-haspopup="true"], [aria-expanded="false"], [data-menu], [class*="dropdown"] button, [class*="nav-item"] button, [class*="Nav"] button, header a[href="#"], nav a[href="#"]',
    );
    const count = Math.min(await triggers.count(), maxTriggers);
    for (let i = 0; i < count; i++) {
      try {
        const el = triggers.nth(i);
        if (!(await el.isVisible({ timeout: 200 }).catch(() => false))) continue;
        await el.hover({ timeout: hoverTimeout });
        await page.waitForTimeout(pauseMs);
        // Some menus need a click (not only hover) to mount links.
        const expanded = await el.getAttribute('aria-expanded').catch(() => null);
        if (expanded === 'false') {
          await el.click({ timeout: hoverTimeout, force: true }).catch(() => {});
          await page.waitForTimeout(pauseMs);
        }
      } catch {
        // Ignore individual hover failures.
      }
    }
  } catch (err) {
    logger.debug(`  [NAV REVEAL WARN] ${(err as Error).message}`);
  }
}

const ASSET_EXTS = new Set([
  '.css', '.js', '.mjs', '.png', '.jpg', '.jpeg', '.gif', '.svg',
  '.webp', '.ico', '.woff', '.woff2', '.ttf', '.eot', '.otf', '.avif',
  '.mp4', '.webm', '.ogg', '.mp3', '.wav', '.pdf', '.json',
]);

const SKIP_ASSET_PATTERNS = [
  /^data:/,
  /^blob:/,
  /^javascript:/,
  /^mailto:/,
  /\.(map)$/i,
  /\/sockjs-node\//,
  /hot-update/,
  /webpack-hmr/,
];

// Requests from these CDNs never need to be fetched/saved - they're map tiles,
// analytics pings, or other noise that prevents networkidle from settling.
const ABORT_PATTERNS = [
  // Map tiles (all tile CDNs)
  /\/\/[abc]\.\w+\.tile\./,
  /tile\.openstreetmap\.org/,
  /maps\.googleapis\.com\/maps\/vt/,
  /api\.mapbox\.com\/styles.*\/tiles/,
  /maps\.gstatic\.com/,
  /cdn\.jsdelivr\.net\/npm\/leaflet.*marker/,
  // Map embed iframes - aborting here prevents the embed JS from even loading,
  // which eliminates the ERR_FAILED tile-fetch console error flood.
  /openstreetmap\.org\/export\/embed/,
  /maps\.google\.com\/maps\?/,
  /google\.com\/maps\/embed/,
  /bing\.com\/maps\/embed/,
  /yandex\.\w+\/map-widget/,
  /2gis\.com\/widget/,
  // Analytics beacons - tracking pings that keep networkidle from settling (NOT the JS files)
  /google-analytics\.com\/[rj]?\/?(collect|r\/collect)/,
  /analytics\.google\.com\/g\/collect/,
  /\bgtm\.js\?id=/,
  /pagead\/viewthroughconversion/,
  /\/bat\.bing\.com\//,
  /clarity\.ms\/collect/,
  /doubleclick\.net\/pagead/,
  /\/tr\?id=[^&]+&ev=/,              // Meta/Facebook pixel events
  /hotjar\.com\/api\/trigger/,
  /cdn\.segment\.com\/analytics\.js\/v1\/[^/]+\/analytics\.min\.js/, // Segment (large, rarely needed)
  /\/log\?format=json&hasfast=true/, // YouTube-specific internal ping
  /\/generate_204/,                  // Chrome connectivity check
  /\/pagead\/lvz/,                   // Google Ads viewability ping
  /\/ccm\/collect/,                  // Google consent
  /\/api\/stats\/(qoe|ads|atr)/,     // YouTube stats pings
  /\/api\/jnn\//,                    // YouTube Jnn telemetry
  /\/youtubei\/v1\/(log|stats)/,     // YouTube internal logging
  // Live chat widgets - these poll aggressively and prevent networkidle
  /intercom\.io\/messenger\//,
  /widget\.intercom\.io/,
  /js\.driftt\.com/,
  /widget\.drift\.com/,
  /js\.hs-scripts\.com/,            // HubSpot embed
  /js-[a-z0-9]+\.hs-scripts\.com/,
  /api\.hubspot\.com\/conversations/,
  /js-[a-z0-9]+\.hsforms\.net\/forms\//, // HubSpot forms runtime
  /forms-[a-z0-9]+\.hsforms\.com\//,     // HubSpot forms API/counters
  /static\.hsappstatic\.net\/ui-forms-embed-components-app\//,
  /hubspotv2\.[^/]+\.webflow\.services\/static\//,
  /cdn\.livechatinc\.com/,
  /lc\.chat\//,
  /static\.zdassets\.com/,          // Zendesk widget
  /ekr\.zdassets\.com/,
  /widget\.freshworks\.com/,
  /wchat\.freshchat\.com/,
  // Cookie consent banners that make long-polling requests
  /consent\.cookiebot\.com\/uc\.js/,
  /cdn\.cookielaw\.org\/scripttemplates/,
  // Payment widgets - Stripe makes persistent keep-alive requests
  /js\.stripe\.com\/v3/,
  /m\.stripe\.network/,
  /r\.stripe\.com/,
  // Social embeds - Twitter, Facebook, Instagram, LinkedIn, TikTok
  /platform\.twitter\.com\/widgets/,
  /syndication\.twitter\.com/,
  /connect\.facebook\.net\/[^/]+\/sdk/,
  /www\.facebook\.com\/plugins\//,
  /www\.instagram\.com\/embed/,
  /badges\.linkedin\.com/,
  /www\.tiktok\.com\/embed/,
  // Comments - Disqus makes many polling requests
  /disqus\.com\/embed\//,
  /disquscdn\.com\/next\/embed/,
  // CAPTCHA - these phone home with challenge tokens
  /www\.google\.com\/recaptcha\/api/,
  /www\.gstatic\.com\/recaptcha/,
  /challenges\.cloudflare\.com\/turnstile/,
  // Additional chat widgets
  /embed\.tawk\.to/,               // Tawk.to live chat
  /client\.crisp\.chat/,           // Crisp chat
  /widget\.tidio\.co/,             // Tidio
  /app\.chatra\.io/,               // Chatra
  // Error reporting beacons
  /sentry\.io\/api\/[0-9]+\/envelope/,
  /ingest\.sentry\.io/,
  /browser\.sentry-cdn\.com/,
];

const SCRIPT_STUB_PATTERNS = [
  /js\.hs-scripts\.com/,
  /js-[a-z0-9]+\.hs-scripts\.com/,
  /js-[a-z0-9]+\.hsforms\.net\/forms\//,
  /hubspotv2\.[^/]+\.webflow\.services\/static\//,
];

const HUBSPOT_FORM_STUB = `
window.hbspt = window.hbspt || {};
window.hbspt.forms = window.hbspt.forms || {};
window.hbspt.forms.create = window.hbspt.forms.create || function () {};
`;

/** Fast budgets on hosted clones; full desktop profile only on local deep clones.
 *  Do NOT treat IS_FAST as "Vercel-only" — Render also uses IS_FAST_CLONE. */
const IS_FAST = IS_FAST_CLONE;
const NAVIGATION_TIMEOUT = IS_FAST ? 18_000 : 30_000;
const ROUTE_FETCH_TIMEOUT = IS_FAST ? 8_000 : 15_000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const MAX_ASSET_BYTES = (IS_FAST ? 8 : 50) * 1024 * 1024; // Align with hosted persist cap so heroes survive.
const MAX_CSS_BYTES = (IS_FAST ? 5 : 25) * 1024 * 1024;
const SERVERLESS_DOM_ASSET_CAP = 400; // Marketing pages need CSS/fonts + many images.
const SHOPIFY_DOM_ASSET_CAP = 700;
// Upper bound on CSS we scan for url()/image-set()/@import references. The old
// 500KB limit silently skipped ref-extraction for big bundles (Tailwind/CMS CSS
// routinely exceeds it), so fonts and background images they referenced never
// downloaded. 4MB covers virtually all real stylesheets while bounding regex cost.
const CSS_REF_SCAN_MAX_BYTES = 4 * 1024 * 1024;

const MARKETING_HOST_SUFFIXES = [
  'shopify.com',
  'myshopify.com',
  'stripe.com',
  'vercel.com',
  'linear.app',
  'notion.so',
  'notion.com',
  'figma.com',
  'framer.com',
  'webflow.com',
  'squarespace.com',
  'airbnb.com',
  'spotify.com',
  'dropbox.com',
  'slack.com',
  'openai.com',
  'anthropic.com',
];

function isShopifyLikeHost(hostname: string): boolean {
  const h = String(hostname || '').toLowerCase();
  return (
    h === 'shopify.com'
    || h === 'www.shopify.com'
    || h.endsWith('.shopify.com')
    || h.endsWith('.myshopify.com')
    || h === 'cdn.shopify.com'
    || h.includes('shopifycdn')
    || h.endsWith('.shopifycloud.com')
  );
}

function isMarketingSiteHost(hostname: string): boolean {
  const h = String(hostname || '').toLowerCase().replace(/^www\./, '');
  if (isShopifyLikeHost(hostname)) return true;
  return MARKETING_HOST_SUFFIXES.some((suffix) => h === suffix || h.endsWith(`.${suffix}`));
}

/** Deeper lazy/scroll/media harvest for brochure homepages and known marketing sites. */
function pageNeedsDeepMediaCapture(pageUrl: string): boolean {
  try {
    const u = new URL(pageUrl);
    if (isMarketingSiteHost(u.hostname)) return true;
    const path = (u.pathname || '/').replace(/\/+$/, '') || '/';
    // Homepages and top-level marketing routes need deep harvest on hosted clones.
    if (path === '/') return true;
    if (path.split('/').filter(Boolean).length <= 1) return true;
    return false;
  } catch {
    return /shopify|stripe|myshopify|vercel\.com/i.test(pageUrl);
  }
}

function hashUrl(url: string): string {
  return createHash('sha1').update(url).digest('hex').slice(0, 16);
}

function assetFetchHeaders(pageUrl: string): Record<string, string> {
  let origin = '';
  try { origin = new URL(pageUrl).origin; } catch { /* ignore */ }
  return {
    'User-Agent': USER_AGENT,
    'Accept': 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    ...(origin ? { Referer: `${origin}/`, Origin: origin } : {}),
    'Accept-Language': 'en-US,en;q=0.9',
  };
}

function decodeHtmlUrl(value: string): string {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/g, "'")
    .trim();
}

/**
 * Prefer a display-quality Shopify CDN URL without requesting the multi‑MB original.
 * Only rewrite when resize params already exist — bare brochure assets keep their path.
 */
function preferLargestSrcsetCandidate(url: string): string {
  try {
    const u = new URL(url);
    if (!/cdn\.shopify\.com$/i.test(u.hostname)
      && !/shopifycdn|shopifycloud|myshopify/i.test(u.hostname)
      && !/\.shopify\.com$/i.test(u.hostname)) {
      return url;
    }
    if (!u.searchParams.has('width') && !u.searchParams.has('height')) {
      return url;
    }
    const widthRaw = u.searchParams.get('width');
    const width = widthRaw ? Number(widthRaw) : NaN;
    u.searchParams.delete('height');
    u.searchParams.delete('crop');
    // Keep a bounded width so clones stay under the hosted media cap.
    if (!Number.isFinite(width) || width < 1200 || width > 2000) {
      u.searchParams.set('width', '1600');
    }
    if (!u.searchParams.has('quality')) u.searchParams.set('quality', '80');
    return u.href;
  } catch {
    return url;
  }
}

function isLiveCdnMediaUrl(url: string): boolean {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return (
      host === 'cdn.shopify.com'
      || host.endsWith('.shopify.com')
      || host.includes('shopifycdn')
      || host.endsWith('.shopifycloud.com')
      || host.endsWith('.myshopify.com')
      || host.endsWith('.imgix.net')
      || host.endsWith('.cloudinary.com')
      || host.endsWith('.stripe.com')
      || host.includes('stripe.com')
      || host.endsWith('.b-cdn.net')
      || host.endsWith('.cloudfront.net')
      || host.endsWith('.akamaihd.net')
      || host.endsWith('.fastly.net')
    );
  } catch {
    return /cdn\.shopify\.com|shopifycdn|shopifycloud|images\.stripe|cloudinary|imgix/i.test(url);
  }
}

/** Brochure assets live in React Router JSON as plain URL strings — not always as <img>/<video> yet. */
function extractShopifyBrochureAssetUrls(html: string): string[] {
  const text = String(html || '').replace(/\\u0026/g, '&').replace(/&amp;/gi, '&');
  const re = /https:\/\/cdn\.shopify\.com\/b\/shopify-brochure2-assets\/[a-f0-9]+\.(?:png|jpe?g|webp|avif|svg|gif|mp4|webm|mov)(?:\?[^"'\\\s]*)?/gi;
  return [...new Set([...text.matchAll(re)].map((m) => m[0]))];
}

function isShopifyBrochureImageUrl(url: string): boolean {
  return /cdn\.shopify\.com\/b\/shopify-brochure2-assets\/[a-f0-9]+\.(?:png|jpe?g|webp|avif|svg|gif)(?:\?|$)/i.test(url);
}

function isShopifyBrochureVideoUrl(url: string): boolean {
  return /cdn\.shopify\.com\/b\/shopify-brochure2-assets\/[a-f0-9]+\.(?:mp4|webm|mov)(?:\?|$)/i.test(url);
}

/** Map video URL → following poster/image URL in brochure payload order. */
function shopifyVideoPosterMap(html: string): Map<string, string> {
  const text = String(html || '').replace(/\\u0026/g, '&').replace(/&amp;/gi, '&');
  const tokens = [...text.matchAll(/https:\/\/cdn\.shopify\.com\/b\/shopify-brochure2-assets\/[a-f0-9]+\.(?:png|jpe?g|webp|avif|svg|gif|mp4|webm|mov)(?:\?[^"'\\\s]*)?/gi)].map((m) => m[0]);
  const map = new Map<string, string>();
  for (let i = 0; i < tokens.length; i++) {
    if (!isShopifyBrochureVideoUrl(tokens[i])) continue;
    for (let j = i + 1; j < Math.min(i + 6, tokens.length); j++) {
      if (isShopifyBrochureImageUrl(tokens[j]) && /\.(?:png|jpe?g|webp|avif)(?:\?|$)/i.test(tokens[j])) {
        map.set(tokens[i], tokens[j]);
        // Also key by basename hash so source.src variants match.
        const hash = tokens[i].match(/\/([a-f0-9]+)\.(?:mp4|webm|mov)/i)?.[1];
        if (hash) map.set(hash, tokens[j]);
        break;
      }
    }
  }
  return map;
}

function shouldSkipAsset(url: string): boolean {
  return SKIP_ASSET_PATTERNS.some((p) => p.test(url));
}

function shouldReportConsoleError(text: string): boolean {
  // Browser "failed to load resource" console lines are usually source-site
  // broken images/beacons. They are handled through asset fallback/rewriting and
  // should not make the clone health panel look broken.
  return !/^Failed to load resource:/i.test(text);
}

function shouldReportPageError(message: string): boolean {
  // Several source sites ship noisy third-party/template scripts that throw this
  // while the rendered DOM is still usable. Keep it in debug logs, but don't
  // count it as a clone script issue.
  const clean = message.trim();
  return !/^Invalid or unexpected token$/i.test(clean)
    && !/^__name is not defined$/i.test(clean);
}

function isImageLikeRequest(url: string, resourceType: string): boolean {
  if (resourceType === 'image') return true;
  try {
    const ext = extname(new URL(url.split('?')[0]).pathname).toLowerCase();
    return ['.png', '.jpg', '.jpeg', '.gif', '.svg', '.webp', '.ico', '.avif'].includes(ext);
  } catch {
    return false;
  }
}

// Matches an image-set()/-webkit-image-set() call, capturing its inner args.
// Tolerates one level of nested parens so url(...) and type(...) inside don't
// truncate the match.
const IMAGE_SET_RE = /(-webkit-)?image-set\(((?:[^()]|\([^()]*\))*)\)/gi;

// Extract url() references from CSS text
export function extractCssUrls(css: string): string[] {
  const urls: string[] = [];
  const re = /url\(\s*(['"]?)([^'")\s]+)\1\s*\)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(css)) !== null) {
    const u = m[2];
    if (!shouldSkipAsset(u)) urls.push(u);
  }
  // @import "url" and @import url(...)
  const importRe = /@import\s+(?:url\(\s*)?['"]([^'"]+)['"]/g;
  while ((m = importRe.exec(css)) !== null) {
    if (!shouldSkipAsset(m[1])) urls.push(m[1]);
  }
  // image-set() bare-string candidates: image-set('a.webp' 1x, 'b.webp' 2x).
  // The url() forms inside image-set are already captured by the url() pass
  // above; this picks up the string-only syntax that pass misses. Skip strings
  // that are type() hints (e.g. 'image/avif').
  while ((m = IMAGE_SET_RE.exec(css)) !== null) {
    const inner = m[2];
    const strRe = /(['"])([^'"]+)\1/g;
    let sm: RegExpExecArray | null;
    while ((sm = strRe.exec(inner)) !== null) {
      const u = sm[2];
      if (u.includes('/') && !u.startsWith('image/') && !shouldSkipAsset(u)) urls.push(u);
    }
  }
  return [...new Set(urls)];
}

// Rewrite url() references in CSS text
function mapAssetUrl(url: string, assetMap: Map<string, string>, baseUrl?: string): string | null {
  const clean = url.split('?')[0].split('#')[0];
  const direct = assetMap.get(url) ?? assetMap.get(clean);
  if (direct) return direct;

  if (baseUrl) {
    try {
      const abs = new URL(url, baseUrl).href;
      return assetMap.get(abs) ?? assetMap.get(abs.split('?')[0].split('#')[0]) ?? null;
    } catch { /* leave unparseable CSS values unchanged */ }
  }

  return null;
}

export function rewriteCssUrls(css: string, assetMap: Map<string, string>, baseUrl?: string): string {
  return css.replace(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/g, (match, quote, url) => {
    const mapped = mapAssetUrl(url, assetMap, baseUrl);
    return mapped ? `url(${quote}${mapped}${quote})` : match;
  }).replace(/@import\s+(?:url\(\s*)?(?:(['"])([^'")]+)\1|([^'")\s;]+))\s*\)?/g, (match, _quote, quotedUrl, bareUrl) => {
    const url = quotedUrl || bareUrl;
    const mapped = mapAssetUrl(url, assetMap, baseUrl);
    return mapped ? match.replace(url, mapped) : match;
  }).replace(IMAGE_SET_RE, (match, prefix, inner) => {
    // Rewrite bare-string image-set URLs. url() forms inside were already
    // localized by the url() pass above (mapAssetUrl returns null for an
    // already-local path, so they pass through unchanged here).
    const newInner = inner.replace(/(['"])([^'"]+)\1/g, (m: string, q: string, url: string) => {
      if (!url.includes('/') || url.startsWith('image/')) return m;
      const mapped = mapAssetUrl(url, assetMap, baseUrl);
      return mapped ? `${q}${mapped}${q}` : m;
    });
    return `${prefix || ''}image-set(${newInner})`;
  });
}

export interface CaptureHooks {
  onArtifactWritten?: (event: ArtifactWrittenEvent) => Promise<void>;
}

export async function capturePage(
  context: BrowserContext,
  pageUrl: string,
  assetsDir: string,
  hooks: CaptureHooks = {},
): Promise<{ record: PageRecord; links: string[] }> {
  ensurePlaceholderAsset(assetsDir);
  const deepMedia = pageNeedsDeepMediaCapture(pageUrl);
  // Marketing/deep pages need deeper scroll even on hosted fast clones.
  const fastScroll = IS_FAST && !deepMedia;
  const domAssetCap = deepMedia
    ? (IS_FAST ? SHOPIFY_DOM_ASSET_CAP : 900)
    : (IS_FAST ? SERVERLESS_DOM_ASSET_CAP : Infinity);
  const maxAssetBytes = deepMedia && IS_FAST
    ? Math.max(MAX_ASSET_BYTES, 8 * 1024 * 1024)
    : MAX_ASSET_BYTES;
  const page = await context.newPage();
  await page.setExtraHTTPHeaders({
    'User-Agent': USER_AGENT,
    'Accept-Language': 'en-US,en;q=0.9',
  });
  await page.addInitScript(() => {
    const win = window as Window & { __name?: <T>(value: T) => T };
    win.__name ||= (value) => value;
  });
  // Shopify (and many brochure sites) gate images behind IntersectionObserver.
  // Force every observation to report intersecting so lazy loaders populate src
  // before we snapshot HTML.
  await page.addInitScript(() => {
    try {
      const IO = window.IntersectionObserver;
      if (!IO) return;
      window.IntersectionObserver = class ForcedIntersectingObserver {
        readonly root: Element | Document | null = null;
        readonly rootMargin = '0px';
        readonly thresholds: ReadonlyArray<number> = [0];
        private readonly cb: IntersectionObserverCallback;
        constructor(callback: IntersectionObserverCallback, options?: IntersectionObserverInit) {
          this.cb = callback;
          this.root = (options?.root as Element | Document | null) ?? null;
          this.rootMargin = options?.rootMargin || '0px';
          this.thresholds = options?.threshold == null
            ? [0]
            : Array.isArray(options.threshold) ? options.threshold : [options.threshold];
        }
        observe(target: Element) {
          const rect = target.getBoundingClientRect();
          const entry = {
            time: performance.now(),
            target,
            isIntersecting: true,
            intersectionRatio: 1,
            boundingClientRect: rect,
            intersectionRect: rect,
            rootBounds: null,
          } as IntersectionObserverEntry;
          queueMicrotask(() => {
            try { this.cb([entry], this as unknown as IntersectionObserver); } catch { /* ignore site handler errors */ }
          });
        }
        unobserve() {}
        disconnect() {}
        takeRecords(): IntersectionObserverEntry[] { return []; }
      } as unknown as typeof IntersectionObserver;
    } catch { /* ignore */ }
  });

  const networkLog: NetworkEntry[] = [];
  const assetMap = new Map<string, string>(); // original URL -> /_assets/filename
  const pendingAssets: Array<() => Promise<void>> = [];
  const processedCssRefs = new Set<string>();
  const consoleErrors: string[] = [];
  // Track CSS local paths -> original text so we can rewrite url() refs after all assets are known
  const cssFilesForRewrite = new Map<string, { localPath: string; cssText: string; sourceUrl: string }>();

  const failedAssets = new Set<string>();
  let assetsIntercepted = 0;
  let assetsSaved = 0;
  let assetsSkipped = 0;
  let networkRequests = 0;

  page.on('console', (msg) => {
    if (msg.type() === 'error') {
      const text = msg.text();
      logger.debug(`  [CONSOLE ERROR] ${text}`);
      if (shouldReportConsoleError(text)) {
        consoleErrors.push(text);
      }
    }
  });

  // URLs whose JSON responses caused a pageerror - stub them as {} on second pass
  const cmsJsonStubs = new Set<string>();

  page.on('pageerror', (err) => {
    const text = `PageError: ${err.message}`;
    if (shouldReportPageError(err.message)) {
      consoleErrors.push(text);
      logger.debug(`  [PAGE ERROR] ${err.message}`);
    } else {
      logger.debug(`  [PAGE ERROR IGNORED] ${err.message}`);
    }
    // "Invalid or unexpected token" almost always comes from eval()/template-literal
    // processing of a JSON API response that contains backticks or unescaped chars.
    // Track the most-recently-seen JSON XHR URLs so we can stub them if needed.
    if (/invalid or unexpected token/i.test(err.message)) {
      for (const entry of networkLog) {
        if (entry.contentType.includes('application/json') && entry.method !== 'CONSOLE_ERROR') {
          cmsJsonStubs.add(entry.url);
        }
      }
    }
  });

  async function notifyArtifactWritten(relPath: string, absPath: string) {
    if (!hooks.onArtifactWritten) return;
    try {
      await hooks.onArtifactWritten({ relPath, absPath, kind: 'asset' });
    } catch (err) {
      logger.warn(`  [OFFLOAD] ${relPath}: ${(err as Error).message}`);
    }
  }

  async function saveAsset(url: string, body: Buffer, contentType: string, forceCss = false): Promise<string | null> {
    if (shouldSkipAsset(url)) return null;
    const maxBytes = (forceCss || contentType.includes('text/css')) ? MAX_CSS_BYTES : maxAssetBytes;
    if (body.length > maxBytes) {
      logger.debug(`  [ASSET SKIP] ${url} - too large (${(body.length / 1024 / 1024).toFixed(1)}MB > ${(maxBytes / 1024 / 1024).toFixed(0)}MB)`);
      return null;
    }
    try {
      const cleanUrl = url.split('?')[0].split('#')[0];
      const hash = hashUrl(url);
      const extFromPath = extname(new URL(cleanUrl).pathname).toLowerCase();
      const extFromMime = mime.extension(contentType);
      const ext = forceCss ? '.css' : (extFromPath || (extFromMime ? `.${extFromMime}` : '.bin'));
      const filename = `${hash}${ext}`;
      const localPath = join(assetsDir, filename);
      const webPath = `/_assets/${filename}`;
      mkdirSync(assetsDir, { recursive: true });

      const isCss = forceCss || ext === '.css' || contentType.includes('text/css');
      const isFont = contentType.includes('font') || /\.(woff2?|ttf|otf|eot)(\?|$)/i.test(ext);
      const needsWrite = !existsSync(localPath);
      if (needsWrite && !reserveServerlessAssetBytes(body.length, { priority: isCss || isFont })) {
        logger.warn(`  [ASSET BUDGET] Skipping ${url.split('/').pop()} — serverless asset budget (${Math.round(SERVERLESS_ASSET_BUDGET_BYTES / 1024 / 1024)} MB) reached`);
        return null;
      }

      if (isCss) {
        const cssText = body.toString('utf8');
        if (needsWrite) {
          writeFileSync(localPath, body);
          assetsSaved++;
          logger.debug(`  [CSS]   ${webPath}  <-  ${url}  (${(body.length / 1024).toFixed(1)}KB, will rewrite urls)`);
          await notifyArtifactWritten(`public/_assets/${filename}`, localPath);
        }
        cssFilesForRewrite.set(webPath, { localPath, cssText, sourceUrl: url });
      } else {
        if (needsWrite) {
          writeFileSync(localPath, body);
          assetsSaved++;
          logger.debug(`  [ASSET] ${webPath}  <-  ${url}  (${(body.length / 1024).toFixed(1)}KB, ${contentType.split(';')[0]})`);
          await notifyArtifactWritten(`public/_assets/${filename}`, localPath);
        }
      }

      assetMap.set(url, webPath);
      assetMap.set(cleanUrl, webPath);
      try {
        const u = new URL(url);
        assetMap.set(u.pathname, webPath);
        // Register Shopify CDN URL without width/height so all srcset variants map.
        if (/cdn\.shopify\.com$/i.test(u.hostname) || /shopifycdn|shopifycloud|myshopify/i.test(u.hostname)) {
          const bare = new URL(u.href);
          bare.searchParams.delete('width');
          bare.searchParams.delete('height');
          bare.searchParams.delete('crop');
          bare.searchParams.delete('quality');
          assetMap.set(bare.href, webPath);
          assetMap.set(bare.pathname, webPath);
        }
      } catch { /* ignore */ }
      return webPath;
    } catch (err) {
      logger.warn(`  [ASSET FAIL] ${url}: ${(err as Error).message}`);
      return null;
    }
  }

  function enqueueCssReferences(cssText: string, sourceUrl: string): void {
    if (processedCssRefs.has(sourceUrl)) return;
    processedCssRefs.add(sourceUrl);

    const cssUrls = extractCssUrls(cssText);
    if (cssUrls.length > 0) {
      logger.debug(`  [CSS REFS] ${cssUrls.length} url() references in ${sourceUrl}`);
    }

    for (const cssUrl of cssUrls) {
      pendingAssets.push(async () => {
        try {
          const absUrl = new URL(cssUrl, sourceUrl).href;
          if (assetMap.has(absUrl)) return;
          const r = await fetch(absUrl, { headers: assetFetchHeaders(pageUrl), signal: AbortSignal.timeout(10_000) });
          if (!r.ok) {
            logger.debug(`  [CSS REF FAIL] ${absUrl} -> HTTP ${r.status}`);
            return;
          }

          const contentType = r.headers.get('content-type') ?? '';
          const pathExt = extname(new URL(absUrl.split('?')[0]).pathname).toLowerCase();
          const isCssRef = contentType.includes('text/css') || pathExt === '.css';
          const maxBytes = isCssRef ? MAX_CSS_BYTES : maxAssetBytes;
          const len = Number(r.headers.get('content-length') || 0);
          if (len > maxBytes) {
            logger.debug(`  [CSS REF SKIP] ${absUrl} - too large (${(len / 1024 / 1024).toFixed(1)}MB > ${(maxBytes / 1024 / 1024).toFixed(0)}MB)`);
            return;
          }

          const subBuf = Buffer.from(await r.arrayBuffer());
          const saved = await saveAsset(absUrl, subBuf, contentType, isCssRef);
          if (!saved) {
            logger.debug(`  [CSS REF SKIP] ${absUrl}`);
            return;
          }

          if (isCssRef && subBuf.length < CSS_REF_SCAN_MAX_BYTES) {
            enqueueCssReferences(subBuf.toString('utf8'), absUrl);
          }
        } catch (err) {
          logger.debug(`  [CSS REF ERR] ${cssUrl}: ${(err as Error).message}`);
        }
      });
    }
  }

  // Intercept all network traffic
  await page.route('**/*', async (route) => {
    const req = route.request();
    const resourceType = req.resourceType();
    const url = req.url();
    networkRequests++;

    if (shouldSkipAsset(url)) {
      assetsSkipped++;
      await route.continue();
      return;
    }

    if (resourceType === 'script' && SCRIPT_STUB_PATTERNS.some((p) => p.test(url))) {
      logger.debug(`  [SCRIPT STUB] ${url}`);
      await route.fulfill({
        status: 200,
        contentType: 'application/javascript; charset=utf-8',
        body: HUBSPOT_FORM_STUB,
      });
      return;
    }

    if (ABORT_PATTERNS.some((p) => p.test(url))) {
      logger.debug(`  [ABORT] ${url}`);
      await route.abort();
      return;
    }

    // Stub JSON API responses that previously caused a pageerror SyntaxError
    if (cmsJsonStubs.has(url)) {
      logger.debug(`  [CMS STUB] ${url} -> {} (caused pageerror on prior load)`);
      await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: '{}' });
      return;
    }

    let response;
    try {
      response = await route.fetch({ timeout: ROUTE_FETCH_TIMEOUT });
    } catch (err) {
      logger.debug(`  [FETCH FAIL] ${url}: ${(err as Error).message}`);
      await route.abort();
      return;
    }

    const status = response.status();
    const contentType = response.headers()['content-type'] ?? '';
    let _pathExt = '';
    try { _pathExt = extname(new URL(url.split('?')[0]).pathname).toLowerCase(); } catch { /* ignore */ }
    const isStylesheetRequest = resourceType === 'stylesheet';
    const isAsset = isStylesheetRequest
      || ASSET_EXTS.has(_pathExt)
      || contentType.startsWith('image/')
      || contentType.startsWith('font/')
      || contentType.startsWith('text/css')
      || contentType.includes('javascript');
    const isJson = contentType.includes('application/json');
    const isText = contentType.startsWith('text/');
    // Check path extension precisely - url.includes('.css') would match /api/file?name=style.css
    const isCss = isStylesheetRequest || contentType.includes('text/css') || _pathExt === '.css';
    const loggedContentType = isCss && !contentType.includes('text/css')
      ? 'text/css; charset=utf-8'
      : contentType;

    if (status >= 400 && isImageLikeRequest(url, resourceType)) {
      // Shopify/CDN hotlink or transient 403/404: do NOT mark failed — leave the
      // absolute CDN URL in HTML so preview can still load the live image.
      if (isLiveCdnMediaUrl(url)) {
        logger.debug(`  [CDN IMAGE KEEP] ${url} -> HTTP ${status} (keeping live URL)`);
        await route.fulfill({ response }).catch(async () => { await route.abort().catch(() => {}); });
        return;
      }
      failedAssets.add(url);
      logger.debug(`  [IMAGE FALLBACK] ${url} -> HTTP ${status}, substituting placeholder`);
      await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: PLACEHOLDER_IMAGE_BODY });
      return;
    }

    let body: string | null = null;
    if ((isJson || isText) && resourceType !== 'document') {
      try { body = (await response.text()).slice(0, 500_000); } catch { /* ignore */ }
    }

    if (resourceType === 'script') {
      const badScriptType = contentType.includes('text/html')
        || contentType.includes('application/json')
        || contentType.includes('text/xml')
        || contentType.includes('application/xml');
      const looksLikeHtml = typeof body === 'string' && /^\s*</.test(body);
      if (badScriptType || looksLikeHtml) {
        logger.debug(`  [JS STUB] ${url} -> ${contentType || 'unknown content type'}, substituting empty script`);
        await route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body: '/* stubbed invalid script response */' });
        return;
      }
    }

    if (resourceType !== 'document') {
      networkLog.push({
        method: req.method(),
        url,
        postData: req.postData(),
        status,
        contentType: loggedContentType,
        body,
      });
      logger.debug(`  [NET] ${req.method()} ${status} ${loggedContentType.split(';')[0].padEnd(30)} ${url}`);
    }

    // Script resource returning an error -> substitute empty JS to prevent syntax errors
    if ((contentType.includes('javascript') || resourceType === 'script') && status >= 400) {
      logger.debug(`  [JS STUB] ${url} -> HTTP ${status}, substituting empty script`);
      await route.fulfill({ status: 200, contentType: 'application/javascript; charset=utf-8', body: '/* stub */' });
      return;
    }

    // XHR/fetch returning text/html with 4xx/5xx is always an error page (not the intended data).
    // Stub as {} so the site's JS doesn't crash trying to eval/parse HTML.
    if ((resourceType === 'xhr' || resourceType === 'fetch') && contentType.includes('text/html') && status >= 400) {
      logger.debug(`  [XHR STUB] ${url} -> HTTP ${status} text/html, substituting {}`);
      await route.fulfill({ status: 200, contentType: 'application/json; charset=utf-8', body: '{}' });
      return;
    }

    if (isAsset && status === 200) {
      assetsIntercepted++;
      try {
        const maxBytes = isCss ? MAX_CSS_BYTES : maxAssetBytes;
        const len = Number(response.headers()['content-length'] || 0);
        if (len > maxBytes) {
          logger.debug(`  [ASSET SKIP] ${url} - too large (${(len / 1024 / 1024).toFixed(1)}MB > ${(maxBytes / 1024 / 1024).toFixed(0)}MB)`);
          await route.fulfill({ response });
          return;
        }
        const buf = await response.body();
        if (buf.length > maxBytes) {
          logger.debug(`  [ASSET SKIP] ${url} - too large (${(buf.length / 1024 / 1024).toFixed(1)}MB > ${(maxBytes / 1024 / 1024).toFixed(0)}MB)`);
          await route.fulfill({ response });
          return;
        }
        const webPath = await saveAsset(url, buf, contentType, isCss);

        if (webPath && isCss && buf.length < CSS_REF_SCAN_MAX_BYTES) {
          enqueueCssReferences(buf.toString('utf8'), url);
        }

      } catch (err) {
        logger.debug(`  [BODY ERR] ${url}: ${(err as Error).message}`);
      }
    }

    await route.fulfill({ response });
  });

  try { // outer try - ensures page.close() always runs
  logger.debug(`  [NAV] -> ${pageUrl}`);
  try {
    const mainResponse = await page.goto(pageUrl, { waitUntil: 'load', timeout: NAVIGATION_TIMEOUT });
    const status = mainResponse?.status();
    if (status && status >= 400) {
      throw new Error(`HTTP ${status}`);
    }
    logger.debug(`  [NAV] load fired for ${pageUrl}`);
    // Wait for networkidle - aborted beacon patterns above help this settle quickly
    await page.waitForLoadState('networkidle', {
      timeout: deepMedia ? (IS_FAST ? 10_000 : 15_000) : (IS_FAST ? 5_000 : 15_000),
    }).catch(() => {});
    logger.debug(`  [NAV] networkidle settled for ${pageUrl}`);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    const isNonFatal = msg.includes('ERR_ABORTED') || msg.includes('net::ERR') || msg.toLowerCase().includes('timeout');
    if (!isNonFatal) throw err;
    logger.debug(`  [NAV WARN] ${msg}`);
  }

  // Wait for web fonts so the HTML snapshot reflects the real rendered state
  await page.evaluate(() => document.fonts.ready).catch(() => {});

  // Scroll to trigger lazy-loaded images and content.
  // Re-check scrollHeight each step - some sites (infinite scroll, lazy sections) grow the page as you scroll.
  // Shopify brochure sections mount per-section IO — use deeper scroll even on hosted.
  await page.evaluate(async (fast: boolean) => {
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const step = Math.max(Math.floor(window.innerHeight * 0.7), 320);
    const started = Date.now();
    const maxSteps = fast ? 22 : 40;
    const maxMs = fast ? 5_000 : 12_000;
    let y = 0;
    let steps = 0;
    while (y < document.body.scrollHeight && steps < maxSteps && Date.now() - started < maxMs) {
      window.scrollTo(0, y);
      await delay(fast ? 65 : 90);
      y += step;
      steps++;
    }
    window.scrollTo(0, document.body.scrollHeight);
    await delay(fast ? 80 : 150);
    // Second pass upward helps sticky/reveal sections that only mount once.
    y = document.body.scrollHeight;
    while (y > 0 && steps < maxSteps + 12 && Date.now() - started < maxMs) {
      y -= step;
      window.scrollTo(0, Math.max(0, y));
      await delay(fast ? 40 : 60);
      steps++;
    }
    window.scrollTo(0, 0);
  }, fastScroll).catch((err) => {
    logger.debug(`  [SCROLL WARN] ${(err as Error).message}`);
  });

  // Force below-fold lazy nodes into view so custom loaders populate src/srcset.
  await page.evaluate(async (budget: { maxNodes: number; pauseMs: number }) => {
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    const nodes = Array.from(document.querySelectorAll(
      'img[loading="lazy"],img[data-src],img[data-srcset],source[data-srcset],source[srcset],picture,video[poster],video[data-src],[data-bg],[data-background],[data-bg-image],[data-lazy-background],[style*="background"]',
    )).slice(0, budget.maxNodes);
    for (const el of nodes) {
      try {
        (el as HTMLElement).scrollIntoView({ block: 'center', inline: 'nearest' });
      } catch { /* ignore */ }
      await delay(budget.pauseMs);
    }
    window.scrollTo(0, 0);
  }, {
    maxNodes: deepMedia ? (IS_FAST ? 100 : 160) : (IS_FAST ? 56 : 60),
    pauseMs: deepMedia ? (IS_FAST ? 40 : 50) : (IS_FAST ? 25 : 30),
  }).catch((err) => {
    logger.debug(`  [SCROLLINTOVIEW WARN] ${(err as Error).message}`);
  });

  // Wait for lazy images to finish loading
  try {
    await page.waitForFunction(() => {
      const imgs = Array.from(document.querySelectorAll('img[loading="lazy"], img[data-src], img[data-srcset], img[srcset]'));
      return imgs.every((img) => (img as HTMLImageElement).complete);
    }, undefined, { timeout: deepMedia ? (IS_FAST ? 4_000 : 5_000) : (IS_FAST ? 2_000 : 2_000) });
  } catch { /* timeout is fine */ }

  // Some sites keep images/videos only in lazy data-* attributes until custom JS runs.
  // Collect those URLs explicitly so the clone includes assets that never fired a request.
  const collectDomAssetUrls = () => page.evaluate(() => {
    const urls: string[] = [];
    const push = (value: string | null) => {
      if (!value) return;
      let v = value.trim();
      if (!v || v.startsWith('#')) return;
      // Shopify data-widths is often JSON like [180,360,540] — not a URL list.
      if (/^\s*\[/.test(v) && !/^https?:/i.test(v)) return;
      v = v.replace(/&amp;/gi, '&').replace(/&quot;/gi, '"');
      urls.push(v);
    };
    const pushSrcset = (value: string | null) => {
      if (!value) return;
      const trimmed = value.trim();
      if (/^\s*\[/.test(trimmed) && !/https?:/i.test(trimmed)) return;
      for (const part of trimmed.split(',')) {
        const url = part.trim().split(/\s+/)[0];
        push(url);
      }
    };

    document.querySelectorAll('img,source,video,embed,object,picture').forEach((el) => {
      for (const attr of [
        'src', 'poster', 'data-src', 'data-lazy-src', 'data-original', 'data-url',
        'data-video', 'data-poster', 'data-master', 'data-bg', 'data-background',
        'data-image', 'data-bg-image', 'data-lazy-background',
      ]) {
        push(el.getAttribute(attr));
      }
      // Never treat data-widths as srcset (Shopify widths JSON).
      for (const attr of ['srcset', 'data-srcset', 'data-lazy-srcset', 'imagesrcset']) {
        pushSrcset(el.getAttribute(attr));
      }
      pushSrcset(el.getAttribute('srcSet'));
    });

    document.querySelectorAll('[style*="background"]').forEach((el) => {
      const style = el.getAttribute('style') || '';
      for (const match of style.matchAll(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi)) {
        push(match[2]);
      }
    });

    // Class-driven backgrounds (computed) — critical for Shopify brochure cards.
    try {
      const nodes = Array.from(document.querySelectorAll('section,article,div,li,figure,a,header,main'));
      let scanned = 0;
      for (const el of nodes) {
        if (scanned++ > 400) break;
        const bg = window.getComputedStyle(el).backgroundImage;
        if (!bg || bg === 'none') continue;
        for (const match of bg.matchAll(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/gi)) {
          push(match[2]);
        }
      }
    } catch { /* ignore */ }

    document.querySelectorAll('link[href]').forEach((el) => {
      const rel = (el.getAttribute('rel') ?? '').toLowerCase();
      if (/(stylesheet|preload|modulepreload|icon|apple-touch-icon|manifest)/.test(rel)) {
        push(el.getAttribute('href'));
        pushSrcset(el.getAttribute('imagesrcset') || el.getAttribute('imageSrcSet'));
      }
    });

    document.querySelectorAll('script[src]').forEach((el) => push(el.getAttribute('src')));

    return [...new Set(urls)];
  }).catch((err) => {
    logger.debug(`  [DOM ASSETS WARN] ${(err as Error).message}`);
    return [] as string[];
  });

  let domAssetUrls = await collectDomAssetUrls();
  // Shopify brochure media is often only referenced inside React Router JSON payloads.
  // Pull those CDN URLs from the raw HTML so we download posters/images even when
  // <img>/<video> tags are not in the DOM yet.
  let videoPosterBySrc = new Map<string, string>();
  if (deepMedia) {
    try {
      const rawHtml = await page.content();
      videoPosterBySrc = shopifyVideoPosterMap(rawHtml);
      const brochureUrls = extractShopifyBrochureAssetUrls(rawHtml)
        .filter((u) => isShopifyBrochureImageUrl(u)); // prefer stills; videos freeze to posters later
      if (brochureUrls.length) {
        logger.debug(`  [SHOPIFY BROCHURE] ${brochureUrls.length} image URLs extracted from page payload`);
        domAssetUrls = [...domAssetUrls, ...brochureUrls];
      }
    } catch (err) {
      logger.debug(`  [SHOPIFY BROCHURE WARN] ${(err as Error).message}`);
    }
  }
  // Normalize Shopify CDN resize variants → one canonical URL each.
  domAssetUrls = [...new Set(
    domAssetUrls
      .map((u) => decodeHtmlUrl(u))
      .map((u) => {
        try { return preferLargestSrcsetCandidate(new URL(u, pageUrl).href); }
        catch { return u; }
      }),
  )];

  if (domAssetUrls.length > 0) {
    logger.debug(`  [DOM ASSETS] ${domAssetUrls.length} lazy/data asset refs found${deepMedia ? ' (shopify deep)' : ''}`);
  }

  const domAssetUrlsToFetch = Number.isFinite(domAssetCap)
    ? [...domAssetUrls].sort((a, b) => domAssetUrlScore(b) - domAssetUrlScore(a)).slice(0, domAssetCap as number)
    : domAssetUrls;
  for (const u of domAssetUrlsToFetch) {
    if (!assetMap.has(u) && !shouldSkipAsset(u) && !ABORT_PATTERNS.some((p) => p.test(u))) {
      pendingAssets.push(async () => {
        try {
          const absUrl = preferLargestSrcsetCandidate(new URL(decodeHtmlUrl(u), pageUrl).href);
          if (assetMap.has(absUrl)) return;
          try {
            const pathOnly = new URL(absUrl).pathname;
            if (assetMap.has(pathOnly)) return;
          } catch { /* ignore */ }
          const r = await fetch(absUrl, {
            headers: assetFetchHeaders(pageUrl),
            signal: AbortSignal.timeout(IS_FAST ? 8_000 : 15_000),
          });
          if (r.ok) {
            const contentType = r.headers.get('content-type') ?? '';
            if (contentType.includes('text/html')) {
              logger.debug(`  [DOM ASSET SKIP] ${absUrl} - document response`);
              return;
            }
            const len = Number(r.headers.get('content-length') || 0);
            if (len > maxAssetBytes) {
              logger.debug(`  [DOM ASSET SKIP] ${absUrl} - too large (${(len / 1024 / 1024).toFixed(1)}MB > ${(maxAssetBytes / 1024 / 1024).toFixed(0)}MB)`);
              return;
            }
            const buf = Buffer.from(await r.arrayBuffer());
            if (buf.length > maxAssetBytes) {
              logger.debug(`  [DOM ASSET SKIP] ${absUrl} - body too large`);
              return;
            }
            await saveAsset(absUrl, buf, contentType);
          } else if (r.status >= 400 && r.status < 500) {
            // Only mark definitive client errors as failed (not timeouts / 5xx).
            // Never fail live Shopify/CDN URLs — preview can still load them.
            if (isLiveCdnMediaUrl(absUrl)) {
              logger.debug(`  [CDN IMAGE KEEP] ${absUrl} -> HTTP ${r.status}`);
            } else {
              logger.debug(`  [DOM ASSET MISSING] ${absUrl} -> HTTP ${r.status}`);
              failedAssets.add(absUrl);
            }
          } else {
            logger.debug(`  [DOM ASSET SKIP] ${absUrl} -> HTTP ${r.status}`);
          }
        } catch (err) {
          // Timeouts / network blips must NOT mark the asset failed — rewriter
          // would replace live Shopify CDN URLs with placeholders.
          logger.debug(`  [DOM ASSET ERR] ${u}: ${(err as Error).message}`);
        }
      });
    }
  }

  // Extract inline <style> CSS urls so we can also download those assets
  const inlineStyleUrls = await page.evaluate(() => {
    const urls: string[] = [];
    document.querySelectorAll('style').forEach((el) => {
      const matches = el.textContent?.matchAll(/url\(['"]?([^'")\s]+)['"]?\)/g) ?? [];
      for (const m of matches) urls.push(m[1]);
    });
    document.querySelectorAll('[style]').forEach((el) => {
      const style = el.getAttribute('style') ?? '';
      const matches = style.matchAll(/url\(['"]?([^'")\s]+)['"]?\)/g);
      for (const m of matches) urls.push(m[1]);
    });
    return urls;
  }).catch((err) => {
    logger.debug(`  [INLINE CSS WARN] ${(err as Error).message}`);
    return [] as string[];
  });

  if (inlineStyleUrls.length > 0) {
    logger.debug(`  [INLINE CSS] ${inlineStyleUrls.length} url() refs in inline styles`);
  }

  const inlineStyleUrlsToFetch = IS_FAST
    ? inlineStyleUrls.slice(0, deepMedia ? 160 : 90)
    : inlineStyleUrls;
  for (const u of inlineStyleUrlsToFetch) {
    if (!assetMap.has(u) && !shouldSkipAsset(u) && !ABORT_PATTERNS.some((p) => p.test(u))) {
      pendingAssets.push(async () => {
        try {
          const absUrl = preferLargestSrcsetCandidate(new URL(decodeHtmlUrl(u), pageUrl).href);
          if (assetMap.has(absUrl)) return;
          const r = await fetch(absUrl, {
            headers: assetFetchHeaders(pageUrl),
            signal: AbortSignal.timeout(IS_FAST ? 8_000 : 15_000),
          });
          if (r.ok) {
            const contentType = r.headers.get('content-type') ?? '';
            if (contentType.includes('text/html')) {
              logger.debug(`  [INLINE CSS SKIP] ${absUrl} - document response`);
              return;
            }
            const len = Number(r.headers.get('content-length') || 0);
            if (len > maxAssetBytes) {
              logger.debug(`  [INLINE CSS SKIP] ${absUrl} - too large (${(len / 1024 / 1024).toFixed(1)}MB > ${(maxAssetBytes / 1024 / 1024).toFixed(0)}MB)`);
              return;
            }
            const buf = Buffer.from(await r.arrayBuffer());
            await saveAsset(absUrl, buf, contentType);
          } else {
            logger.debug(`  [INLINE CSS MISSING] ${absUrl} -> skipped`);
          }
        } catch (err) {
          logger.debug(`  [INLINE CSS ERR] ${u}: ${(err as Error).message}`);
        }
      });
    }
  }

  // Fetch pending CSS-referenced assets in batches to avoid OOM from too many parallel fetches
  const PENDING_BATCH = IS_FAST ? 4 : 10;
  let failedPending = 0;
  let pendingIndex = 0;
  while (pendingIndex < pendingAssets.length) {
    const batch = pendingAssets.slice(pendingIndex, pendingIndex + PENDING_BATCH);
    pendingIndex += batch.length;
    const settled = await Promise.allSettled(batch.map((fn) => fn()));
    failedPending += settled.filter((r) => r.status === 'rejected').length;
  }
  if (failedPending > 0) {
    logger.debug(`  [PENDING] ${failedPending}/${pendingAssets.length} pending asset fetches failed`);
  }

  // Post-process: rewrite url() references in all captured CSS files now that assetMap is complete
  let cssRewritten = 0;
  let cssUrlsReplaced = 0;
  for (const [, { localPath, cssText, sourceUrl }] of cssFilesForRewrite) {
    try {
      const rewritten = rewriteCssUrls(cssText, assetMap, sourceUrl);
      if (rewritten !== cssText) {
        writeFileSync(localPath, rewritten, 'utf8');
        cssRewritten++;
        const origMatches = (cssText.match(/url\(/g) ?? []).length;
        const newMatches = (rewritten.match(/url\(\/_assets\//g) ?? []).length;
        cssUrlsReplaced += newMatches;
        logger.debug(`  [CSS REWRITE] ${sourceUrl}: ${newMatches}/${origMatches} url() refs rewritten`);
        const assetName = localPath.split(/[/\\]/).pop();
        if (assetName) {
          await notifyArtifactWritten(`public/_assets/${assetName}`, localPath);
        }
      }
    } catch (err) {
      logger.debug(`  [CSS REWRITE ERR] ${sourceUrl}: ${(err as Error).message}`);
    }
  }

  // -- Interaction pass: click tabs/accordions/carousels to surface content ----
  try {
    const interactiveSelectors = [
      '[role="tab"]',
      '[data-toggle]',
      '[data-tab]',
      '[data-panel]',
      'details > summary',
      '.tab, .tabs__item, .tab-link, .nav-tab',
      '[aria-controls]',
    ];
    const carouselSelectors = [
      'button[aria-label*="next" i]',
      'button[name="next"]',
      '[class*="slideshow"] button[class*="next"]',
      '[class*="carousel"] [class*="next"]',
      '[data-slider-next]',
      '.slider-button--next',
    ];
    const clickTargets = await page.evaluate((selectors: string[]) => {
      const MAX = 10;
      const seen = new Set<string>();
      const results: Array<{ selector: string; idx: number; text: string }> = [];
      for (const sel of selectors) {
        if (results.length >= MAX) break;
        const els = [...document.querySelectorAll<HTMLElement>(sel)].slice(0, 4);
        els.forEach((el, idx) => {
          const key = sel + '__' + idx;
          if (seen.has(key)) return;
          seen.add(key);
          results.push({ selector: sel, idx, text: el.textContent?.trim().slice(0, 30) ?? '' });
        });
      }
      return results.slice(0, MAX);
    }, interactiveSelectors);

    const carouselClicks = IS_FAST ? 3 : 8;
    for (let i = 0; i < carouselClicks; i++) {
      for (const sel of carouselSelectors) {
        try {
          const btn = page.locator(sel).first();
          if (await btn.count() === 0) continue;
          await btn.click({ timeout: 1500, force: true });
          await page.waitForTimeout(IS_FAST ? 200 : 400);
        } catch { /* best-effort */ }
      }
    }

    if (clickTargets.length > 0) {
      logger.debug(`  [INTERACT] Clicking ${clickTargets.length} interactive element(s) to surface API calls`);
      for (const target of clickTargets) {
        try {
          const el = await page.locator(`${target.selector}`).nth(target.idx);
          await el.click({ timeout: 2000, force: true });
          await page.waitForTimeout(300);
        } catch { /* click may fail on hidden/stale element */ }
      }
      await page.waitForLoadState('networkidle', { timeout: IS_FAST ? 2_000 : 6_000 }).catch(() => {});
    }
  } catch { /* interaction pass is best-effort */ }

  // Final networkidle wait after scroll + interaction
  await page.waitForLoadState('networkidle', { timeout: IS_FAST ? 2_000 : 8_000 }).catch(() => {});

  // Collect lazy image URLs again after carousel/tab interaction.
  const moreDomAssets = await collectDomAssetUrls();
  if (moreDomAssets.length) {
    const normalizedMore = [...new Set(
      moreDomAssets
        .map((u) => decodeHtmlUrl(u))
        .map((u) => {
          try { return preferLargestSrcsetCandidate(new URL(u, pageUrl).href); }
          catch { return u; }
        }),
    )];
    domAssetUrls = [...new Set([...domAssetUrls, ...normalizedMore])];
    const extraToFetch = IS_FAST
      ? normalizedMore.sort((a, b) => domAssetUrlScore(b) - domAssetUrlScore(a)).slice(0, deepMedia ? 160 : 80)
      : normalizedMore;
    const postInteractAssets: Array<() => Promise<void>> = [];
    for (const u of extraToFetch) {
      if (!assetMap.has(u) && !shouldSkipAsset(u) && !ABORT_PATTERNS.some((p) => p.test(u))) {
        postInteractAssets.push(async () => {
          try {
            const absUrl = preferLargestSrcsetCandidate(new URL(decodeHtmlUrl(u), pageUrl).href);
            if (assetMap.has(absUrl)) return;
            try {
              if (assetMap.has(new URL(absUrl).pathname)) return;
            } catch { /* ignore */ }
            const r = await fetch(absUrl, {
              headers: assetFetchHeaders(pageUrl),
              signal: AbortSignal.timeout(IS_FAST ? 8_000 : 15_000),
            });
            if (r.ok) {
              const contentType = r.headers.get('content-type') ?? '';
              if (contentType.includes('text/html')) return;
              const len = Number(r.headers.get('content-length') || 0);
              if (len > maxAssetBytes) return;
              const buf = Buffer.from(await r.arrayBuffer());
              await saveAsset(absUrl, buf, contentType);
            } else if (r.status >= 400 && r.status < 500) {
              if (isLiveCdnMediaUrl(absUrl)) {
                logger.debug(`  [CDN IMAGE KEEP] ${absUrl} -> HTTP ${r.status}`);
              } else {
                failedAssets.add(absUrl);
              }
            }
          } catch { /* best-effort — do not mark failed on timeout */ }
        });
      }
    }
    for (let i = 0; i < postInteractAssets.length; i += PENDING_BATCH) {
      await Promise.all(postInteractAssets.slice(i, i + PENDING_BATCH).map((fn) => fn()));
    }
  }

  // Two-pass: if a pageerror caused by CMS JSON was detected on the first load,
  // reload the page now that those URLs are stubbed as {} so the JS doesn't crash
  // and the HTML snapshot reflects a clean render.
  // Allow one CMS JSON stub reload on start/marketing pages even on fast clones.
  if ((!IS_FAST || deepMedia) && cmsJsonStubs.size > 0) {
    logger.debug(`  [TWO-PASS] ${cmsJsonStubs.size} CMS JSON stub(s) detected; reloading for clean snapshot`);
    try {
      await page.goto(pageUrl, { waitUntil: 'load', timeout: NAVIGATION_TIMEOUT });
      await page.waitForLoadState('networkidle', { timeout: 12_000 }).catch(() => {});
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      logger.debug(`  [TWO-PASS WARN] ${msg}`);
    }
  }

  // Promote lazy-load attributes to real src/srcset BEFORE snapshotting. Many
  // lazy-loaders only swap data-src->src via IntersectionObserver, which never
  // fires for below-fold images in a static snapshot — so the real image (which
  // we DID download) would render blank. Only promote when the current src is
  // missing or an obvious placeholder, so already-loaded images keep their value.
  await page.evaluate(() => {
    const isPlaceholder = (src: string | null): boolean => {
      if (!src) return true;
      const s = src.trim();
      if (!s) return true;
      if (s.startsWith('data:')) return true; // inline 1x1 / blur placeholder
      return /(?:^|[/_-])(?:placeholder|blank|spacer|lazy|loading|transparent|pixel|1x1|grey|gray)\b/i.test(s);
    };
    const firstAttr = (el: Element, names: string[]): string | null => {
      for (const n of names) {
        const v = el.getAttribute(n);
        if (v && v.trim() && !v.trim().startsWith('#')) return v.trim();
      }
      return null;
    };
    document.querySelectorAll('img,source').forEach((el) => {
      const isLowRes = (src: string | null): boolean => {
        if (!src) return true;
        return /[?&]width=(?:1[0-9]|[2-9]\d)(?:&|$)/i.test(src) || /_((?:small|thumb|icon|tiny))[\W]/i.test(src);
      };
      const realSrc = firstAttr(el, ['data-src', 'data-lazy-src', 'data-original', 'data-url', 'data-master']);
      const currentSrc = el.getAttribute('src');
      if (realSrc && (isPlaceholder(currentSrc) || isLowRes(currentSrc))) el.setAttribute('src', realSrc);
      const realSrcset = firstAttr(el, ['data-srcset', 'data-lazy-srcset']);
      if (realSrcset && !/^\s*\[/.test(realSrcset) && (!el.getAttribute('srcset') || isPlaceholder(currentSrc) || isLowRes(currentSrc))) {
        el.setAttribute('srcset', realSrcset);
      }
      if (el.getAttribute('loading') === 'lazy') el.setAttribute('loading', 'eager');
    });
    // data-bg / data-background -> inline background-image for elements whose
    // background was meant to be injected by a lazy script.
    document.querySelectorAll('[data-bg],[data-background],[data-bg-image],[data-image],[data-lazy-background]').forEach((el) => {
      const bg = firstAttr(el, ['data-bg', 'data-background', 'data-bg-image', 'data-image', 'data-lazy-background']);
      const style = el.getAttribute('style') || '';
      if (bg && !/background(-image)?\s*:/i.test(style)) {
        el.setAttribute('style', `${style}${style && !style.trim().endsWith(';') ? ';' : ''}background-image:url("${bg}")`);
      }
    });
  }).catch((err) => {
    logger.debug(`  [LAZY PROMOTE WARN] ${(err as Error).message}`);
  });

  // Wait for decoded images after scroll — critical for Next.js fill images whose
  // parents collapse when src is still a blur placeholder.
  try {
    await page.waitForFunction(() => {
      const imgs = Array.from(document.querySelectorAll('img'));
      return imgs.every((img) => {
        const el = img as HTMLImageElement;
        const src = el.getAttribute('src');
        if (!src && !el.getAttribute('srcset')) return true;
        if (src?.startsWith('data:')) return true;
        return el.complete && el.naturalWidth > 0;
      });
    }, undefined, { timeout: deepMedia ? (IS_FAST ? 8_000 : 12_000) : (IS_FAST ? 4_000 : 10_000) });
  } catch { /* partial load is still better than an empty snapshot */ }

  // Rasterize large canvas/WebGL visuals (e.g. Shopify globe) into <img> so static HTML keeps them.
  if (deepMedia) {
    try {
      const canvasPayloads = await page.evaluate((limit: number) => {
        const out: Array<{ dataUrl: string; width: number; height: number; replaceId: string }> = [];
        const canvases = Array.from(document.querySelectorAll('canvas'));
        for (const canvas of canvases) {
          if (out.length >= limit) break;
          const el = canvas as HTMLCanvasElement;
          const rect = el.getBoundingClientRect();
          const w = el.width || Math.round(rect.width);
          const h = el.height || Math.round(rect.height);
          if (w < 80 || h < 80) continue;
          try {
            const dataUrl = el.toDataURL('image/png');
            if (!dataUrl || dataUrl.length < 1000) continue;
            const replaceId = `clonyfy-canvas-${out.length}-${Date.now()}`;
            el.setAttribute('data-clonyfy-canvas-id', replaceId);
            out.push({ dataUrl, width: w, height: h, replaceId });
          } catch {
            /* tainted canvas — skip */
          }
        }
        return out;
      }, IS_FAST ? 4 : 8);

      for (const item of canvasPayloads) {
        try {
          const base64 = item.dataUrl.replace(/^data:image\/png;base64,/, '');
          const buf = Buffer.from(base64, 'base64');
          if (buf.length > maxAssetBytes) continue;
          const filename = `canvas_${hashUrl(item.replaceId)}.png`;
          const localPath = join(assetsDir, filename);
          const webPath = `/_assets/${filename}`;
          if (!existsSync(localPath)) {
            if (!reserveServerlessAssetBytes(buf.length)) continue;
            writeFileSync(localPath, buf);
            assetsSaved++;
            await notifyArtifactWritten(`public/_assets/${filename}`, localPath);
          }
          assetMap.set(webPath, webPath);
          await page.evaluate(({ replaceId, webPath, width, height }) => {
            const canvas = document.querySelector(`canvas[data-clonyfy-canvas-id="${replaceId}"]`);
            if (!canvas || !canvas.parentElement) return;
            const img = document.createElement('img');
            img.src = webPath;
            img.width = width;
            img.height = height;
            img.alt = '';
            img.setAttribute('data-clonyfy-canvas-capture', '1');
            const style = window.getComputedStyle(canvas);
            img.style.cssText = `display:block;width:${style.width || width + 'px'};height:${style.height || height + 'px'};max-width:100%;`;
            canvas.replaceWith(img);
          }, { replaceId: item.replaceId, webPath, width: item.width, height: item.height });
        } catch (err) {
          logger.debug(`  [CANVAS CAPTURE WARN] ${(err as Error).message}`);
        }
      }
    } catch (err) {
      logger.debug(`  [CANVAS SCAN WARN] ${(err as Error).message}`);
    }
  }

  // Freeze Next.js <Image> fill layouts for static HTML. Without hydration the
  // absolute-positioned img can collapse when parent dimensions are unset.
  await page.evaluate(() => {
    const pickSrcFromSrcset = (srcset: string | null, fallback?: string | null): string | null => {
      if (!srcset) return fallback || null;
      const parts = srcset.split(',').map((p) => p.trim()).filter(Boolean);
      const pick =
        parts.find((p) => /\b1920w\b/.test(p))
        || parts.find((p) => /\b1080w\b/.test(p))
        || parts.find((p) => /\b828w\b/.test(p))
        || parts[parts.length - 1];
      return pick ? pick.split(/\s+/)[0] : (fallback || null);
    };
    document.querySelectorAll('img[data-nimg="fill"],img[data-nimg="responsive"]').forEach((img) => {
      let el: HTMLElement | null = img.parentElement;
      for (let depth = 0; depth < 4 && el; depth++) {
        const cs = window.getComputedStyle(el);
        if (cs.position === 'static') el.style.position = 'relative';
        if (!el.style.width && cs.width && cs.width !== '0px') el.style.width = cs.width;
        if (!el.style.height && cs.height && cs.height !== '0px') el.style.height = cs.height;
        if (el.style.position !== 'static' && el.style.width && el.style.height) break;
        el = el.parentElement;
      }
      const srcset = img.getAttribute('srcset');
      const picked = pickSrcFromSrcset(srcset, img.getAttribute('src'));
      if (picked) img.setAttribute('src', picked);
      img.removeAttribute('data-nimg');
    });
  }).catch((err) => {
    logger.debug(`  [NIMG FREEZE WARN] ${(err as Error).message}`);
  });

  // Framer Motion / scroll-reveal sites ship elements at opacity:0 and only animate
  // them in via JS. In a static snapshot (and especially on serverless where scroll
  // is fast) those elements stay invisible. Freeze the post-scroll visible state.
  await revealNavDropdownLinks(page);

  // Shopify brochure sections use Tailwind opacity-0 + delay-500/duration-1000.
  // Give transitions time to finish, hydrate media, freeze videos to posters, then reveal.
  // Never let this enrichment fail the whole page capture (OOM/timeout → 0 pages).
  if (deepMedia) {
    try {
    await page.waitForTimeout(IS_FAST ? 1800 : 2600).catch(() => {});
    // Wait until key marketing sections have some media or timeout.
    await page.waitForFunction(() => {
      const needles = [
        /Your brand has entered the chat/i,
        /Sell more in more places/i,
        /Sell face to face/i,
      ];
      let foundMedia = 0;
      for (const re of needles) {
        const el = [...document.querySelectorAll('h1,h2,h3,h4,p,span')].find((n) => re.test(n.textContent || ''));
        if (!el) continue;
        const root = el.closest('section') || el.closest('[class*="section"]') || el.parentElement?.parentElement;
        if (root && root.querySelector('img,video,picture,source,canvas')) foundMedia++;
      }
      const videos = document.querySelectorAll('video').length;
      const imgs = document.querySelectorAll('img[src*="cdn.shopify"], img[src*="brochure"]').length;
      return foundMedia >= 1 || videos >= 1 || imgs >= 8;
    }, undefined, { timeout: IS_FAST ? 6_000 : 10_000 }).catch(() => {});

    // Refresh poster map + download stills referenced by hydrated DOM (not guessed fills).
    try {
      const hydratedHtml = await page.content();
      const more = shopifyVideoPosterMap(hydratedHtml);
      for (const [k, v] of more) videoPosterBySrc.set(k, v);
      const moreImages = extractShopifyBrochureAssetUrls(hydratedHtml).filter((u) => isShopifyBrochureImageUrl(u));
      const brochurePending: Array<() => Promise<void>> = [];
      for (const u of moreImages.slice(0, IS_FAST ? 120 : 250)) {
        if (assetMap.has(u) || shouldSkipAsset(u)) continue;
        brochurePending.push(async () => {
          try {
            const absUrl = preferLargestSrcsetCandidate(new URL(decodeHtmlUrl(u), pageUrl).href);
            if (assetMap.has(absUrl)) return;
            const r = await fetch(absUrl, {
              headers: assetFetchHeaders(pageUrl),
              signal: AbortSignal.timeout(IS_FAST ? 8_000 : 15_000),
            });
            if (!r.ok) return;
            const buf = Buffer.from(await r.arrayBuffer());
            if (buf.length > maxAssetBytes) return;
            await saveAsset(absUrl, buf, r.headers.get('content-type') || 'image/png');
          } catch { /* best-effort */ }
        });
      }
      const batch = IS_FAST ? 4 : 10;
      for (let i = 0; i < brochurePending.length; i += batch) {
        await Promise.all(brochurePending.slice(i, i + batch).map((fn) => fn()));
      }
      if (brochurePending.length) {
        logger.debug(`  [SHOPIFY BROCHURE] downloaded ${brochurePending.length} still assets after hydrate`);
      }
    } catch (err) {
      logger.debug(`  [SHOPIFY BROCHURE HYDRATE WARN] ${(err as Error).message}`);
    }

    // Scroll key marketing sections into view so React can mount the real media.
    await page.evaluate(async () => {
      const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
      const needles = [
        /Your brand has entered the chat/i,
        /Sell more in more places/i,
        /Sell face to face/i,
        /Put your products where shoppers/i,
        /Shop app/i,
        /multichannel/i,
      ];
      for (const re of needles) {
        const el = [...document.querySelectorAll('h1,h2,h3,h4,p,span,a')].find((n) => re.test(n.textContent || ''));
        if (!el) continue;
        try {
          (el as HTMLElement).scrollIntoView({ block: 'center', inline: 'nearest' });
        } catch { /* ignore */ }
        await delay(350);
      }
      window.scrollTo(0, 0);
    }).catch(() => {});
    await page.waitForTimeout(IS_FAST ? 900 : 1500).catch(() => {});

    // Freeze ONLY real videos: prefer site poster attr, else matched poster by source URL,
    // else screenshot the live video frame. Never invent/guess section images.
    const posterEntries = [...videoPosterBySrc.entries()];
    await page.evaluate((posters: Array<[string, string]>) => {
      const posterMap = new Map(posters);
      const resolvePoster = (video: HTMLVideoElement): string => {
        const direct = (video.getAttribute('poster') || '').trim();
        if (direct && !direct.startsWith('data:')) return direct;
        const candidates = [
          video.getAttribute('src') || '',
          video.currentSrc || '',
          ...Array.from(video.querySelectorAll('source')).map((s) => s.getAttribute('src') || ''),
        ].filter(Boolean);
        for (const src of candidates) {
          if (posterMap.has(src)) return posterMap.get(src) || '';
          const hash = src.match(/\/([a-f0-9]+)\.(?:mp4|webm|mov)/i)?.[1];
          if (hash && posterMap.has(hash)) return posterMap.get(hash) || '';
        }
        return '';
      };

      document.querySelectorAll('video').forEach((node, index) => {
        const video = node as HTMLVideoElement;
        const poster = resolvePoster(video);
        if (!poster) {
          video.setAttribute('data-clonyfy-needs-frame', String(index));
          return;
        }
        const img = document.createElement('img');
        img.src = poster;
        img.alt = video.getAttribute('aria-label') || video.getAttribute('title') || '';
        img.loading = 'eager';
        img.decoding = 'sync';
        const cs = window.getComputedStyle(video);
        img.style.cssText = [
          'display:block',
          'width:100%',
          'height:100%',
          'max-width:100%',
          'object-fit:cover',
          cs.borderRadius && cs.borderRadius !== '0px' ? `border-radius:${cs.borderRadius}` : '',
        ].filter(Boolean).join(';');
        img.setAttribute('data-clonyfy-video-poster', '1');
        video.replaceWith(img);
      });
    }, posterEntries).catch((err) => {
      logger.debug(`  [SHOPIFY VIDEO POSTER WARN] ${(err as Error).message}`);
    });

    // Screenshot remaining live videos (actual frame from the real site — not a random asset).
    try {
      const needFrame = page.locator('video[data-clonyfy-needs-frame]');
      const frameCount = Math.min(await needFrame.count(), IS_FAST ? 6 : 12);
      for (let i = 0; i < frameCount; i++) {
        const loc = needFrame.nth(i);
        try {
          await loc.scrollIntoViewIfNeeded({ timeout: 1500 }).catch(() => {});
          await loc.evaluate(async (v) => {
            const video = v as HTMLVideoElement;
            video.muted = true;
            video.playsInline = true;
            video.setAttribute('playsinline', '');
            try {
              if (video.readyState < 2) {
                await new Promise<void>((resolve) => {
                  const done = () => resolve();
                  video.addEventListener('loadeddata', done, { once: true });
                  setTimeout(done, 1200);
                });
              }
              video.currentTime = Math.min(0.35, Number.isFinite(video.duration) ? video.duration * 0.08 : 0.35);
              await new Promise<void>((resolve) => {
                const done = () => resolve();
                video.addEventListener('seeked', done, { once: true });
                setTimeout(done, 800);
              });
            } catch { /* ignore */ }
            try { await video.play(); } catch { /* ignore autoplay block */ }
            await new Promise((r) => setTimeout(r, 180));
            try { video.pause(); } catch { /* ignore */ }
          });
          const buf = await loc.screenshot({ type: 'png', timeout: 4000 });
          if (!buf || buf.length < 800) continue;
          if (buf.length > maxAssetBytes) continue;
          const filename = `video_frame_${hashUrl(`${pageUrl}#video-${i}`)}.png`;
          const localPath = join(assetsDir, filename);
          const webPath = `/_assets/${filename}`;
          if (!existsSync(localPath)) {
            if (!reserveServerlessAssetBytes(buf.length)) continue;
            writeFileSync(localPath, buf);
            assetsSaved++;
            await notifyArtifactWritten(`public/_assets/${filename}`, localPath);
          }
          assetMap.set(webPath, webPath);
          await loc.evaluate((v, path) => {
            const video = v as HTMLVideoElement;
            const img = document.createElement('img');
            img.src = path;
            img.alt = video.getAttribute('aria-label') || video.getAttribute('title') || '';
            img.loading = 'eager';
            img.setAttribute('data-clonyfy-video-frame', '1');
            const cs = window.getComputedStyle(video);
            img.style.cssText = [
              'display:block',
              'width:100%',
              'height:100%',
              'max-width:100%',
              'object-fit:cover',
              cs.borderRadius && cs.borderRadius !== '0px' ? `border-radius:${cs.borderRadius}` : '',
            ].filter(Boolean).join(';');
            video.replaceWith(img);
          }, webPath);
        } catch (err) {
          logger.debug(`  [SHOPIFY VIDEO FRAME WARN] ${(err as Error).message}`);
        }
      }
    } catch (err) {
      logger.debug(`  [SHOPIFY VIDEO FRAME SCAN WARN] ${(err as Error).message}`);
    }

    await page.waitForFunction(() => {
      const imgs = Array.from(document.querySelectorAll(
        'img[data-clonyfy-video-poster], img[data-clonyfy-video-frame], section img[src*="cdn.shopify"], main img[src*="cdn.shopify"]',
      ));
      if (!imgs.length) return true;
      const ready = imgs.filter((img) => {
        const el = img as HTMLImageElement;
        return el.complete && el.naturalWidth > 0;
      }).length;
      return ready >= Math.min(imgs.length, Math.max(2, Math.floor(imgs.length * 0.4)));
    }, undefined, { timeout: IS_FAST ? 5_000 : 8_000 }).catch(() => {});
    } catch (deepErr) {
      logger.warn(`  [SHOPIFY DEEP MEDIA WARN] ${(deepErr as Error).message} — continuing with base snapshot`);
    }
  }

  await page.evaluate(async (fast: boolean, carouselSkip: string, shopifyDeep: boolean) => {
    const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));
    await delay(fast ? 500 : 1500);

    const isZeroOpacity = (value: string | null | undefined): boolean => {
      if (!value) return false;
      const n = parseFloat(value);
      return Number.isFinite(n) && n <= 0.01;
    };
    const hasSize = (el: Element) => {
      const rect = el.getBoundingClientRect();
      return rect.width >= 2 && rect.height >= 2;
    };
    const overlapsSiblingText = (el: Element): boolean => {
      const parent = el.parentElement;
      if (!parent || parent.children.length < 2) return false;
      const a = el.getBoundingClientRect();
      if (a.width < 40 || a.height < 16) return false;
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      if (text.length < 2 || text.length > 180) return false;
      for (const sib of Array.from(parent.children)) {
        if (sib === el) continue;
        const st = (sib.textContent || '').replace(/\s+/g, ' ').trim();
        if (st.length < 2 || st.length > 180) continue;
        const b = sib.getBoundingClientRect();
        const ix = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
        const iy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
        const inter = ix * iy;
        if (inter <= 0) continue;
        const minArea = Math.min(Math.max(1, a.width * a.height), Math.max(1, b.width * b.height));
        if (inter / minArea >= 0.45) return true;
      }
      return false;
    };

    const shouldResetTransform = (transform: string): boolean => {
      if (!transform || transform === 'none') return false;
      if (/translateY\([^)]*-?\d{2,}/.test(transform)) return true;
      if (/translate3d\([^)]*,\s*-?\d{2,}/.test(transform)) return true;
      return false;
    };

    const isStackedRotatorPhrase = (el: HTMLElement, cls: string): boolean => {
      if (el.getAttribute('aria-hidden') === 'true') return true;
      if (el.closest('.clonyfy-stacked-rotator,[aria-hidden="true"]')) return true;
      if (overlapsSiblingText(el)) return true;
      // Tiny text-only opacity-0 nodes in heroes are usually stacked phrases.
      const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
      const hasMedia = !!(el.querySelector && el.querySelector('img,picture,video,source,canvas,svg'));
      if (/\bopacity-0\b/.test(cls) && !hasMedia && text.length > 0 && text.length < 80) {
        const r = el.getBoundingClientRect();
        if (r.height > 0 && r.height < 120) return true;
      }
      return false;
    };

    // Marketing sites: strip reveal-animation utility classes so static HTML is visible.
    if (shopifyDeep) {
      document.querySelectorAll('[class*="opacity-0"],[class*="translate-y-"]').forEach((node) => {
        const el = node as HTMLElement;
        if (el.closest(carouselSkip)) return;
        const cls = String(el.className || '');
        if (isStackedRotatorPhrase(el, cls)) return;
        el.classList.remove('opacity-0');
        // Keep transform utilities from permanently hiding sections.
        for (const c of Array.from(el.classList)) {
          if (/^translate-y-(?:\d+|full)$/.test(c) || /^delay-\d+$/.test(c)) el.classList.remove(c);
        }
        el.style.setProperty('opacity', '1', 'important');
        el.style.setProperty('visibility', 'visible', 'important');
        el.style.setProperty('transform', 'none', 'important');
      });
    }

    document.querySelectorAll('*').forEach((node) => {
      const el = node as HTMLElement;
      if (el.closest(carouselSkip)) return;
      const cls = String(el.className || '');
      if (isStackedRotatorPhrase(el, cls)) return;
      const style = el.style;
      const cs = window.getComputedStyle(el);
      if (!hasSize(el)) return;

      // Preserve real CSS / WAAPI animations (Shopify marquees, hero motion, etc.)
      const animName = String(cs.animationName || '');
      const hasCssAnim = !!animName && animName !== 'none';
      const hasMotionClass = /\b(animate|motion|marquee|ticker|scroll|parallax|ken-burns|kenburns)\b/i.test(cls);
      if (hasCssAnim || hasMotionClass) return;

      // Reveal Tailwind opacity-0 sections (brochure cards) — previously skipped entirely.
      if (/\bopacity-0\b/.test(cls)) {
        el.classList.remove('opacity-0');
        style.setProperty('opacity', '1', 'important');
      }

      if (isZeroOpacity(style.opacity)) {
        const computed = parseFloat(cs.opacity);
        style.opacity = computed > 0.05 ? String(computed) : '1';
      } else if (parseFloat(cs.opacity) <= 0.01) {
        style.opacity = '1';
      }
      if (style.visibility === 'hidden' || cs.visibility === 'hidden') {
        style.visibility = 'visible';
      }

      const transform = style.transform || cs.transform;
      if (shouldResetTransform(transform)) style.transform = 'none';
    });
  }, fastScroll, CAROUSEL_SKIP_SELECTOR, deepMedia).catch((err) => {
    logger.debug(`  [VISIBILITY FREEZE WARN] ${(err as Error).message}`);
  });

  await page.evaluate(normalizeAllMotionStacksInDocument).catch((err) => {
    logger.debug(`  [CAROUSEL NORMALIZE WARN] ${(err as Error).message}`);
  });

  const html = await page.content();

  // Shopify/Remix/Next sometimes paint an Application Error boundary mid-capture when
  // stubbed XHR/JS races hydration. Prefer a second snapshot after a short settle if so.
  let finalHtml = html;
  try {
    const isAppError = await page.evaluate(() => {
      const text = (document.body?.innerText || '').replace(/\s+/g, ' ');
      return /Application Error/i.test(text)
        && /page could not be displayed|Something has gone wrong/i.test(text);
    });
    if (isAppError) {
      logger.warn(`  [APP ERROR] ${pageUrl} looks like a framework error boundary; waiting and re-snapshotting`);
      await page.waitForTimeout(IS_FAST ? 800 : 2000);
      await page.waitForLoadState('networkidle', { timeout: IS_FAST ? 2_000 : 6_000 }).catch(() => {});
      const retryHtml = await page.content();
      const stillError = /Application Error/i.test(retryHtml)
        && /page could not be displayed|Something has gone wrong/i.test(retryHtml);
      if (!stillError) finalHtml = retryHtml;
      else logger.warn(`  [APP ERROR] ${pageUrl} still showing error boundary after retry`);
    }
  } catch { /* best-effort */ }

  // Extract real page links, including SPA routes recorded from pushState/replaceState.
  const origin = new URL(pageUrl).origin;
  const linkData = await page.evaluate((origin: string) => {
    const found = new Set<string>();
    const navFound = new Set<string>();
    const push = (value: string | null | undefined, nav = false) => {
      if (!value) return;
      try {
        const href = new URL(value, window.location.href).href;
        if (href.startsWith(origin)) {
          found.add(href);
          if (nav) navFound.add(href);
        }
      } catch {
        // Ignore invalid route-like values.
      }
    };

    // Primary chrome only — do NOT include footer (country/locale pickers flood the crawl).
    const primaryNavSelectors = [
      'header nav a[href]',
      'header [role="navigation"] a[href]',
      'nav[aria-label] a[href]',
      '[role="navigation"] a[href]',
      'header a[href]',
      '[data-js-target="nav"] a[href]',
      '[class*="GlobalNav"] a[href]',
      '[class*="global-nav"] a[href]',
      '[class*="PrimaryNav"] a[href]',
      '[class*="primary-nav"] a[href]',
      '[class*="SiteHeader"] a[href]',
      '[class*="site-header"] a[href]',
      '[class*="MegaMenu"] a[href]',
      '[class*="mega-menu"] a[href]',
      '[class*="Dropdown"] a[href]',
      '[class*="dropdown-menu"] a[href]',
    ].join(',');
    document.querySelectorAll(primaryNavSelectors).forEach((a) => {
      const el = a as HTMLAnchorElement;
      // Skip language/region switchers inside the header.
      if (el.closest('[aria-label*="anguage" i], [aria-label*="ocale" i], [aria-label*="ountr" i], [aria-label*="egion" i], [data-testid*="locale" i], [data-testid*="language" i], [class*="Locale" i], [class*="locale-picker" i], [class*="Language" i], [class*="Country" i], [class*="region-picker" i]')) {
        push(el.href, false);
        return;
      }
      push(el.href, true);
    });

    document.querySelectorAll('a[href]').forEach((a) => push((a as HTMLAnchorElement).href));
    document.querySelectorAll('[href],[to],[routerlink],[data-href],[data-url],[data-link],[data-route],[data-page]').forEach((el) => {
      for (const attr of ['href', 'to', 'routerlink', 'data-href', 'data-url', 'data-link', 'data-route', 'data-page']) {
        const val = el.getAttribute(attr);
        if (val?.startsWith('/') || val?.startsWith(origin)) push(val);
      }
    });

    // hreflang alternates are other-locale copies of this page — keep as low-priority links only.
    document.querySelectorAll('link[rel][href]').forEach((el) => {
      const rel = (el.getAttribute('rel') ?? '').toLowerCase();
      if (rel.includes('alternate') && el.hasAttribute('hreflang')) {
        push(el.getAttribute('href'), false);
        return;
      }
      if (/(canonical|next|prev)/.test(rel)) push(el.getAttribute('href'));
    });

    document.querySelectorAll('meta[property="og:url"],meta[name="twitter:url"]').forEach((el) => {
      push(el.getAttribute('content'));
    });

    const spaNavs = (window as Window & { __clonyfyNavs?: string[] }).__clonyfyNavs ?? [];
    spaNavs.forEach((href) => push(href));

    return { links: [...found], navLinks: [...navFound] };
  }, origin).catch((err) => {
    logger.debug(`  [LINKS WARN] ${(err as Error).message}`);
    return { links: [] as string[], navLinks: [] as string[] };
  });
  const links = linkData.links
    .map((link) => normalizePageUrl(link, pageUrl))
    .filter((link): link is string => !!link && new URL(link).origin === origin);
  const navLinks = linkData.navLinks
    .map((link) => normalizePageUrl(link, pageUrl))
    .filter((link): link is string => !!link && new URL(link).origin === origin);

  const seenPaths = new Set<string>();
  const assets: AssetEntry[] = Array.from(assetMap.entries())
    .filter(([, localPath]) => {
      if (seenPaths.has(localPath)) return false;
      seenPaths.add(localPath);
      return true;
    })
    .map(([originalUrl, localPath]) => ({ originalUrl, localPath }));

  const route = (() => {
    try { return new URL(pageUrl).pathname || '/'; } catch { return '/'; }
  })();

  if (consoleErrors.length > 0) {
    networkLog.push({
      method: 'CONSOLE_ERROR',
      url: pageUrl,
      postData: null,
      status: 0,
      contentType: 'text/plain',
      body: consoleErrors.join('\n'),
    });
  }

  logger.debug(
    `  [PAGE DONE] ${pageUrl}\n` +
    `    network=${networkRequests} intercepted=${assetsIntercepted} saved=${assetsSaved} skipped=${assetsSkipped}\n` +
    `    css_files=${cssFilesForRewrite.size} css_rewritten=${cssRewritten} css_urls_fixed=${cssUrlsReplaced}\n` +
    `    links_found=${links.length} console_errors=${consoleErrors.length}`,
  );

  return {
    record: { url: pageUrl, route, html: finalHtml, assets, network: networkLog, failedAssets: [...failedAssets] },
    links: [...new Set(links)],
    navLinks: [...new Set(navLinks)],
  };

  } finally {
    await page.close().catch(() => {}); // safe even if context was already closed externally
  }
}
