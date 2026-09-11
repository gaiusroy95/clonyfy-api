import PQueue from 'p-queue';
import { createHash } from 'crypto';
import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { extname, join } from 'path';
import mime from 'mime-types';
import { capturePage, extractCssUrls } from './capture.js';
import { logger } from './logger.js';
import { normalizePageUrl } from './pageUrls.js';
import {
  isLocaleOnlyPath,
  isLocalePrefixedPath,
  shouldSkipLocaleVariant,
} from './localePaths.js';
import {
  IS_FAST_CLONE,
  IS_SERVERLESS,
  resetServerlessAssetBudget,
  reserveServerlessAssetBytes,
  SERVERLESS_ASSET_BUDGET_BYTES,
} from './serverlessBudget.js';
import type { ArtifactWrittenEvent, AssetEntry, ClonerOptions, PageRecord } from './types.js';

export { isLocaleOnlyPath, isLocalePrefixedPath, shouldSkipLocaleVariant } from './localePaths.js';
export { isFastCloneProfile, isServerlessRuntime } from './serverlessBudget.js';

type ChromiumLauncher = typeof import('playwright-core').chromium;

const NON_PAGE_EXTS = new Set([
  '.7z','.aac','.avi','.avif','.bin','.bmp','.css','.csv','.doc','.docx',
  '.eot','.exe','.gif','.gz','.ico','.jpeg','.jpg','.js','.json','.map',
  '.mjs','.mov','.mp3','.mp4','.ogg','.ogv','.otf','.pdf','.png','.ppt',
  '.pptx','.rar','.rss','.svg','.tar','.tgz','.ttf','.txt','.wav','.webm',
  '.webp','.woff','.woff2','.xls','.xlsx','.xml','.zip',
]);
const NAV_DELAY_MS = IS_FAST_CLONE ? 50 : 250;
const PAGE_CAPTURE_TIMEOUT = IS_FAST_CLONE ? 60_000 : 150_000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';
const STATIC_ASSET_LIMIT = IS_FAST_CLONE ? 260 : 400;
const STATIC_ASSET_TIMEOUT = IS_FAST_CLONE ? 10_000 : 10_000;
const STATIC_PAGE_TIMEOUT = IS_FAST_CLONE ? 15_000 : 15_000;
const STATIC_ASSET_MAX_BYTES = (IS_FAST_CLONE ? 8 : 50) * 1024 * 1024;
const STATIC_ASSET_CONCURRENCY = IS_FAST_CLONE ? 6 : 12;
const STATIC_PAGE_ASSET_TIMEOUT = IS_FAST_CLONE ? 18_000 : 60_000;
export function shouldUseStaticFirstServerless(
  env: NodeJS.ProcessEnv = process.env,
  serverless = IS_SERVERLESS,
): boolean {
  if (!serverless) return false;
  if (env.CLONYFY_BROWSER_FIRST === '1') return false;
  // Browser-first by default for better SPA support. Crawler auto-falls-back to
  // static if Chromium fails to launch. Force static via CLONYFY_STATIC_FIRST=1.
  return env.CLONYFY_STATIC_FIRST === '1';
}

const STATIC_FIRST_SERVERLESS = shouldUseStaticFirstServerless();

export function shouldUseBundledChromium(
  playwrightPath: string,
  platform: NodeJS.Platform = process.platform,
  serverless = IS_SERVERLESS,
): boolean {
  return serverless || (platform === 'linux' && !existsSync(playwrightPath));
}

export function systemBrowserChannel(
  playwrightPath: string,
  platform: NodeJS.Platform = process.platform,
  serverless = IS_SERVERLESS,
): 'msedge' | 'chrome' | undefined {
  if (serverless || existsSync(playwrightPath)) return undefined;
  if (platform === 'win32') return 'msedge';
  if (platform === 'darwin') return 'chrome';
  return undefined;
}

async function getChromiumLaunchOptions(chromium: ChromiumLauncher) {
  const playwrightPath = IS_SERVERLESS ? '' : chromium.executablePath();
  const useBundledChromium = shouldUseBundledChromium(playwrightPath);
  const channel = systemBrowserChannel(playwrightPath);
  let sparticuzChromium: typeof import('@sparticuz/chromium').default | null = null;
  let executablePath: string | undefined;
  if (useBundledChromium) {
    try {
      sparticuzChromium = (await import('@sparticuz/chromium')).default;
      executablePath = await sparticuzChromium.executablePath();
    } catch (err) {
      logger.warn(`  [BROWSER] Bundled Chromium unavailable: ${(err as Error).message}`);
      executablePath = undefined;
    }
  }

  if (useBundledChromium) {
    logger.debug(`  [BROWSER] Using bundled Chromium: ${executablePath}`);
  } else if (channel) {
    logger.debug(`  [BROWSER] Playwright Chromium missing; using system ${channel}`);
  }

  return {
    executablePath,
    channel,
    args: [
      ...(sparticuzChromium ? sparticuzChromium.args : []),
      '--disable-blink-features=AutomationControlled',
      '--no-sandbox',
      '--disable-setuid-sandbox',
    ],
  };
}

function hashUrl(url: string): string {
  return createHash('sha1').update(url).digest('hex').slice(0, 16);
}

export const SITEMAP_SEED_CAP = IS_SERVERLESS ? 20 : 80;
export const START_URL_CAPTURE_TIMEOUT = IS_SERVERLESS
  ? (IS_FAST_CLONE ? 90_000 : 150_000)
  : 300_000;

const LOW_PRIORITY_PATH_RE = /^\/(legal|privacy|terms|cookie|gdpr|compliance|policy|policies|disclaimer|imprint|sitemap)(\/|$)/i;

export function isProbablyHtmlDocument(text: string, contentType?: string | null): boolean {
  if (contentType && /text\/html|application\/xhtml\+xml/i.test(contentType)) return true;
  const trimmed = text.trimStart().slice(0, 512).toLowerCase();
  return trimmed.startsWith('<!doctype html')
    || trimmed.startsWith('<html')
    || (trimmed.includes('<head') && trimmed.includes('<body'));
}

export function prioritizeSitemapUrls(
  urls: string[],
  startUrl: string,
  cap = SITEMAP_SEED_CAP,
): string[] {
  const startNorm = normalizePageUrl(startUrl);
  const scored = new Map<string, number>();

  for (const raw of urls) {
    const clean = normalizePageUrl(raw, startUrl);
    if (!clean) continue;
    // Never seed locale market roots / translated trees for a default-language clone.
    if (shouldSkipLocaleVariant(clean, startUrl)) continue;

    let score = 0;
    try {
      const path = new URL(clean).pathname || '/';
      const depth = path.split('/').filter(Boolean).length;
      score -= depth * 10;
      if (startNorm && clean === startNorm) score += 1_000;
      if (LOW_PRIORITY_PATH_RE.test(path)) score -= 500;
      if (isLocaleOnlyPath(path) || isLocalePrefixedPath(path)) score -= 800;
      if (/\.(html?|php|aspx?)$/i.test(path)) score -= 5;
    } catch {
      // Keep neutral score for malformed URLs that still normalized.
    }

    scored.set(clean, Math.max(scored.get(clean) ?? -Infinity, score));
  }

  return [...scored.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, cap)
    .map(([url]) => url);
}

async function fetchSitemap(origin: string): Promise<string[]> {
  const candidates = new Set([
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/sitemap.txt`,
  ]);
  const found: string[] = [];
  const fetchedSitemaps = new Set<string>();

  try {
    const robots = await fetch(`${origin}/robots.txt`, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(IS_SERVERLESS ? 2_000 : 5_000),
    });
    if (robots.ok) {
      const text = await robots.text();
      for (const match of text.matchAll(/^sitemap:\s*(\S+)/gim)) {
        candidates.add(match[1].trim());
      }
    }
  } catch {
    // robots sitemap hints are optional.
  }

  async function parseSitemapText(url: string, text: string) {
    if (url.endsWith('.txt')) {
      text.split('\n')
        .map((line) => line.trim())
        .filter((line) => normalizePageUrl(line))
        .forEach((line) => found.push(line));
      return;
    }

    if (/<sitemapindex/i.test(text)) {
      const nestedUrls = [...text.matchAll(/<sitemap>\s*<loc>\s*(https?:\/\/[^<]+)\s*<\/loc>/gi)]
        .map((m) => m[1].trim());
      for (const nestedUrl of nestedUrls.slice(0, IS_SERVERLESS ? 20 : 80)) {
        if (fetchedSitemaps.has(nestedUrl)) continue;
        fetchedSitemaps.add(nestedUrl);
        try {
          const res = await fetch(nestedUrl, {
            headers: { 'User-Agent': USER_AGENT },
            signal: AbortSignal.timeout(IS_SERVERLESS ? 3_000 : 8_000),
          });
          if (!res.ok) continue;
          const nestedType = res.headers.get('content-type');
          const nestedText = await res.text();
          if (isProbablyHtmlDocument(nestedText, nestedType)) continue;
          await parseSitemapText(nestedUrl, nestedText);
        } catch {
          // Skip unreachable child sitemap.
        }
      }
      return;
    }

    const locs = [...text.matchAll(/<loc>\s*(https?:\/\/[^<]+)\s*<\/loc>/gi)]
      .map((m) => m[1].trim())
      .filter((loc) => normalizePageUrl(loc));
    found.push(...locs);
  }

  for (const url of candidates) {
    if (fetchedSitemaps.has(url)) continue;
    fetchedSitemaps.add(url);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': USER_AGENT },
        signal: AbortSignal.timeout(IS_SERVERLESS ? 3_000 : 8_000),
      });
      if (!res.ok) continue;
      const contentType = res.headers.get('content-type');
      const text = await res.text();
      if (isProbablyHtmlDocument(text, contentType)) {
        logger.debug(`  [SITEMAP] Ignoring HTML document at ${url}`);
        continue;
      }
      await parseSitemapText(url, text);
      if (found.length > 0) {
        logger.info(`  Found ${found.length} URLs in sitemap: ${url}`);
        break;
      }
    } catch {
      // No sitemap at this location.
    }
  }
  return [...new Set(found)];
}

function routeForUrl(url: string): string {
  try {
    const pathname = new URL(url).pathname || '/';
    return pathname === '/index.html' ? '/' : pathname;
  } catch {
    return '/';
  }
}

function looksLikePageHref(value: string): boolean {
  const clean = value.trim();
  if (!clean || clean.startsWith('#')) return false;
  if (/^(https?:)?\/\//i.test(clean)) return true;
  if (clean.startsWith('/')) return true;
  if (/^[a-z0-9._~/-]+(?:[?#][^\s]*)?$/i.test(clean)) return true;
  return false;
}

function linkEnqueuePriority(url: string, fromNav = false): number {
  // Primary header/nav links must outrank sitemap filler and footer noise.
  let score = fromNav ? 200 : 10;
  try {
    const path = new URL(url).pathname || '/';
    if (LOW_PRIORITY_PATH_RE.test(path)) score -= 120;
    if (isLocaleOnlyPath(path)) score -= 500;
    if (isLocalePrefixedPath(path)) score -= 400;
    const depth = path.split('/').filter(Boolean).length;
    score -= depth * 3;
  } catch {}
  return score;
}

function shouldSkipPageUrl(url: string, startUrl?: string): boolean {
  try {
    const parsed = new URL(url);
    const pathname = parsed.pathname;
    const ext = extname(pathname).toLowerCase();
    if (ext && NON_PAGE_EXTS.has(ext)) return true;
    if (/^\/cdn-cgi\//i.test(pathname)) return true;
    if (startUrl && shouldSkipLocaleVariant(url, startUrl)) return true;
    return false;
  } catch {
    return true;
  }
}

function visitedPageVariants(url: string): string[] {
  try {
    const parsed = new URL(url);
    const base = `${parsed.origin}${parsed.pathname.replace(/\/$/, '')}`;
    return base.endsWith('.html')
      ? [url, base.replace(/\.html$/i, '')]
      : [url, `${base}.html`];
  } catch {
    return [url];
  }
}

function extractLinksFromHtml(html: string, pageUrl: string, origin: string): string[] {
  const found = new Set<string>();
  const attrRe = /\b(?:href|to|routerlink|data-href|data-url|data-link|data-route|data-page)=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;

  while ((match = attrRe.exec(html)) !== null) {
    if (!looksLikePageHref(match[1])) continue;
    const href = normalizePageUrl(match[1], pageUrl);
    if (href && new URL(href).origin === origin) found.add(href);
  }

  const linkRe = /<link\b[^>]*\bhref=["']([^"']+)["'][^>]*>/gi;
  while ((match = linkRe.exec(html)) !== null) {
    if (!looksLikePageHref(match[1])) continue;
    const href = normalizePageUrl(match[1], pageUrl);
    if (href && new URL(href).origin === origin) found.add(href);
  }

  const metaRe = /<meta\b[^>]*>/gi;
  while ((match = metaRe.exec(html)) !== null) {
    const tag = match[0];
    if (!/\b(?:property|name)=["'](?:og:url|twitter:url|canonical)["']/i.test(tag)) continue;
    const content = tag.match(/\bcontent=["']([^"']+)["']/i)?.[1];
    if (!content || !looksLikePageHref(content)) continue;
    const href = normalizePageUrl(content, pageUrl);
    if (href && new URL(href).origin === origin) found.add(href);
  }

  return [...found];
}

function pushSrcsetUrls(value: string | null | undefined, out: Set<string>): void {
  if (!value) return;
  for (const part of value.split(',')) {
    const candidate = part.trim().split(/\s+/)[0];
    if (candidate) out.add(candidate);
  }
}

function extractStaticAssetUrls(html: string): string[] {
  const found = new Set<string>();
  const attrRe = /\b(?:src|href|poster|data-src|data-lazy-src|data-original|data-bg|data-background|data-image|data-bg-image|data-lazy-background)=["']([^"']+)["']/gi;
  let match: RegExpExecArray | null;
  while ((match = attrRe.exec(html)) !== null) {
    const value = match[1].trim();
    if (value && !normalizePageUrl(value)) found.add(value);
  }

  const srcsetRe = /\b(?:srcset|data-srcset|data-lazy-srcset)=["']([^"']+)["']/gi;
  while ((match = srcsetRe.exec(html)) !== null) pushSrcsetUrls(match[1], found);

  for (const cssUrl of extractCssUrls(html)) found.add(cssUrl);
  return [...found];
}

async function saveStaticAsset(rawUrl: string, pageUrl: string, assetsDir: string): Promise<AssetEntry | null> {
  if (/^(data|blob|javascript|mailto|tel):/i.test(rawUrl)) return null;

  let absUrl: string;
  try {
    absUrl = new URL(rawUrl, pageUrl).href;
  } catch {
    return null;
  }

  try {
    const res = await fetch(absUrl, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(STATIC_ASSET_TIMEOUT),
    });
    if (!res.ok) return null;
    const contentType = res.headers.get('content-type') ?? '';
    if (/text\/html|application\/xhtml\+xml/i.test(contentType)) return null;

    const len = Number(res.headers.get('content-length') || 0);
    if (len > STATIC_ASSET_MAX_BYTES) return null;

    const body = Buffer.from(await res.arrayBuffer());
    if (body.length > STATIC_ASSET_MAX_BYTES) return null;

    const cleanUrl = absUrl.split('?')[0].split('#')[0];
    const extFromPath = extname(new URL(cleanUrl).pathname).toLowerCase();
    const extFromMime = mime.extension(contentType);
    const ext = extFromPath || (extFromMime ? `.${extFromMime}` : '.bin');
    const filename = `${hashUrl(absUrl)}${ext}`;
    const localPath = join(assetsDir, filename);
    const webPath = `/_assets/${filename}`;
    mkdirSync(assetsDir, { recursive: true });
    if (!existsSync(localPath)) {
      const isPriority = contentType.includes('text/css')
        || contentType.includes('font')
        || /\.(css|woff2?|ttf|otf|eot)(\?|$)/i.test(ext);
      if (!reserveServerlessAssetBytes(body.length, { priority: isPriority })) {
        logger.warn(`  [ASSET BUDGET] Skipping ${absUrl.split('/').pop()} — serverless asset budget (${Math.round(SERVERLESS_ASSET_BUDGET_BYTES / 1024 / 1024)} MB) reached`);
        return null;
      }
      writeFileSync(localPath, body);
    }

    return { originalUrl: absUrl, localPath: webPath };
  } catch {
    return null;
  }
}

async function runLimited<T>(
  items: T[],
  concurrency: number,
  task: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (index < items.length) {
      const item = items[index++];
      await task(item);
    }
  });
  await Promise.allSettled(workers);
}

async function collectStaticAssets(
  html: string,
  url: string,
  assetsDir: string,
  maxAssets = STATIC_ASSET_LIMIT,
  maxDurationMs = STATIC_PAGE_ASSET_TIMEOUT,
): Promise<AssetEntry[]> {
  const assets = new Map<string, AssetEntry>();
  const startedAt = Date.now();
  const seenAssetUrls = new Set<string>();
  const cssAssetUrls: Array<{ rawUrl: string; baseUrl: string }> = [];

  const hasTime = () => Date.now() - startedAt < maxDurationMs;
  const remainingSlots = () => Math.max(0, maxAssets - seenAssetUrls.size);
  const saveAndTrack = async (rawAssetUrl: string, baseUrl: string) => {
    if (!hasTime() || remainingSlots() <= 0) return;
    let key = rawAssetUrl;
    try { key = new URL(rawAssetUrl, baseUrl).href; } catch {}
    if (seenAssetUrls.has(key)) return;
    seenAssetUrls.add(key);

    const saved = await saveStaticAsset(rawAssetUrl, baseUrl, assetsDir);
    if (!saved) return;
    assets.set(saved.originalUrl, saved);

    if (/\.css(?:$|[?#])/i.test(saved.originalUrl) && hasTime() && remainingSlots() > 0) {
      try {
        const cssRes = await fetch(saved.originalUrl, {
          headers: { 'User-Agent': USER_AGENT },
          signal: AbortSignal.timeout(STATIC_ASSET_TIMEOUT),
        });
        if (cssRes.ok) {
          const cssText = await cssRes.text();
          cssAssetUrls.push(...extractCssUrls(cssText).map((rawUrl) => ({ rawUrl, baseUrl: saved.originalUrl })));
        }
      } catch {
        // CSS dependency capture is best-effort.
      }
    }
  };

  const assetUrls = extractStaticAssetUrls(html).slice(0, maxAssets);
  await runLimited(assetUrls, STATIC_ASSET_CONCURRENCY, (rawAssetUrl) => saveAndTrack(rawAssetUrl, url));

  if (hasTime() && cssAssetUrls.length > 0 && remainingSlots() > 0) {
    await runLimited(
      cssAssetUrls.slice(0, remainingSlots()),
      STATIC_ASSET_CONCURRENCY,
      (cssAssetUrl) => saveAndTrack(cssAssetUrl.rawUrl, cssAssetUrl.baseUrl),
    );
  }

  if (!hasTime()) {
    logger.info(`  [FALLBACK] Asset capture hit ${(maxDurationMs / 1000).toFixed(0)}s budget; continuing with ${assets.size} asset(s)`);
  }

  return [...assets.values()];
}

async function fetchStaticPage(
  url: string,
  origin: string,
  assetsDir: string,
  options: { captureAssets?: boolean; maxAssets?: number; maxAssetDurationMs?: number } = {},
): Promise<{ record: PageRecord; links: string[] }> {
  let res: Response | null = null;
  let lastErr: unknown = null;
  for (let attempt = 1; attempt <= (IS_SERVERLESS ? 3 : 1); attempt++) {
    try {
      res = await fetch(url, {
        headers: {
          'User-Agent': USER_AGENT,
          'Accept': 'text/html,application/xhtml+xml',
          'Accept-Language': 'en-US,en;q=0.9',
        },
        signal: AbortSignal.timeout(STATIC_PAGE_TIMEOUT),
      });
      break;
    } catch (err) {
      lastErr = err;
      if (attempt < (IS_SERVERLESS ? 3 : 1)) {
        await new Promise((resolve) => setTimeout(resolve, 350 * attempt));
      }
    }
  }
  if (!res) throw lastErr instanceof Error ? lastErr : new Error(String(lastErr || 'Static page fetch failed'));
  if (res.status === 429) {
    // Rate-limited — back off and retry once before giving up.
    const retryAfter = Number(res.headers.get('retry-after') || '0');
    const waitMs = retryAfter > 0 ? Math.min(retryAfter * 1000, 15_000) : 5_000;
    logger.warn(`  [429] ${url} — backing off ${waitMs}ms then retrying`);
    await new Promise((r) => setTimeout(r, waitMs));
    const retry = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT, 'Accept': 'text/html,*/*;q=0.8', 'Accept-Language': 'en-US,en;q=0.9' },
      signal: AbortSignal.timeout(STATIC_PAGE_TIMEOUT),
    });
    if (!retry.ok) throw new Error(`HTTP ${retry.status}`);
    res = retry;
  } else if (!res.ok) {
    throw new Error(`HTTP ${res.status}`);
  }
  const contentType = res.headers.get('content-type') || '';
  if (contentType && !/(text\/html|application\/xhtml\+xml)/i.test(contentType)) {
    throw new Error(`Not an HTML page (${contentType})`);
  }
  const html = await res.text();
  // Promote common lazy attrs so static harvest can find real image URLs.
  const promotedHtml = html
    .replace(/\sdata-src=(["'])([^"']+)\1/gi, (m, q, url) => ` src=${q}${url}${q}${m}`)
    .replace(/\sdata-srcset=(["'])([^"']+)\1/gi, (m, q, url) => ` srcset=${q}${url}${q}${m}`)
    .replace(/\sdata-lazy-src=(["'])([^"']+)\1/gi, (m, q, url) => ` src=${q}${url}${q}${m}`);
  const links = extractLinksFromHtml(promotedHtml, url, origin);
  const assets = options.captureAssets === false
    ? []
    : await collectStaticAssets(promotedHtml, url, assetsDir, options.maxAssets, options.maxAssetDurationMs);

  return {
    record: {
      url,
      route: routeForUrl(url),
      html: promotedHtml,
      assets,
      network: [],
      failedAssets: [],
    },
    links,
  };
}

async function crawlStatic(
  opts: ClonerOptions,
  origin: string,
  assetsDir: string,
  visited: Set<string>,
  records: PageRecord[],
  onPage: (record: PageRecord) => void,
  reason: string,
): Promise<PageRecord[]> {
  logger.warn(`  [FALLBACK] Using static HTML crawler (${reason})`);

  const staticQueue: Array<{ url: string; depth: number }> = [];
  const enqueueStatic = (url: string, currentDepth: number) => {
    const clean = normalizePageUrl(url);
    if (!clean) return;
    try { if (new URL(clean).origin !== origin) return; } catch { return; }
    if (shouldSkipPageUrl(clean, opts.url)) return;
    if (visitedPageVariants(clean).some((variant) => visited.has(variant))) return;
    if (visited.size >= opts.maxPages) return;
    visited.add(clean);
    staticQueue.push({ url: clean, depth: currentDepth });
  };

  enqueueStatic(opts.url, 0);
  logger.info('  Checking sitemap...');
  const sitemapUrls = prioritizeSitemapUrls(await fetchSitemap(origin), opts.url);
  const remaining = Math.max(0, opts.maxPages - visited.size);
  for (const url of sitemapUrls.slice(0, remaining)) enqueueStatic(url, 1);

  for (let index = 0; index < staticQueue.length && records.length < opts.maxPages; index++) {
    const item = staticQueue[index];
    logger.info(`  [${records.length + 1}/${opts.maxPages}] ${item.url}`);
    try {
      logger.info(`  [FALLBACK] Static HTML fetch for ${item.url}`);
      const { record, links } = await fetchStaticPage(item.url, origin, assetsDir, { captureAssets: false });
      records.push(record);
      if (item.depth < opts.depth) {
        for (const link of links) enqueueStatic(link, item.depth + 1);
      }
    } catch (fallbackErr) {
      logger.warn(`  [SKIP] ${item.url}: ${(fallbackErr as Error).message}`);
    }
  }

  if (records.length > 0) {
    logger.info(`  [FALLBACK] Capturing assets for ${records.length} static page(s)...`);
    await runLimited(records, Math.min(4, STATIC_ASSET_CONCURRENCY), async (record) => {
      record.assets = await collectStaticAssets(record.html, record.url, assetsDir, STATIC_ASSET_LIMIT, STATIC_PAGE_ASSET_TIMEOUT);
      await Promise.resolve(onPage(record));
    });
  }

  return records;
}

export interface CrawlHooks {
  onArtifactWritten?: (event: ArtifactWrittenEvent) => Promise<void>;
}

export async function crawl(
  opts: ClonerOptions,
  assetsDir: string,
  onPage: (record: PageRecord) => void | Promise<void>,
  hooks: CrawlHooks = {},
): Promise<PageRecord[]> {
  resetServerlessAssetBudget();
  const origin = new URL(opts.url).origin;
  const visited = new Set<string>();
  const queue = new PQueue({ concurrency: opts.concurrency });
  const records: PageRecord[] = [];

  if (STATIC_FIRST_SERVERLESS) {
    return crawlStatic(opts, origin, assetsDir, visited, records, onPage, 'serverless static-first mode');
  }

  const { chromium } = await import('playwright-core');
  const launchOptions = await getChromiumLaunchOptions(chromium);

  let browser: Awaited<ReturnType<ChromiumLauncher['launch']>>;
  try {
    browser = await chromium.launch({
      headless: true,
      ...launchOptions,
    });
  } catch (err) {
    return crawlStatic(opts, origin, assetsDir, visited, records, onPage, `browser launch failed: ${(err as Error).message.split('\n')[0]}`);
  }

  const startNorm = normalizePageUrl(opts.url);
  let sitemapUrls: string[] = [];
  let startUrlFinished = false;
  let sitemapFetchDone = false;
  let sitemapEnqueued = false;

  const maybeEnqueueSitemap = () => {
    if (sitemapEnqueued || !startUrlFinished || !sitemapFetchDone) return;
    sitemapEnqueued = true;
    const remaining = Math.max(0, opts.maxPages - visited.size);
    if (remaining <= 0) {
      logger.info('  Sitemap seeding skipped — page budget already filled by discovered links');
      return;
    }
    const prioritized = prioritizeSitemapUrls(sitemapUrls, opts.url, remaining);
    if (prioritized.length > 0) {
      logger.info(`  Seeding ${prioritized.length} sitemap URL(s) into remaining budget (${remaining})`);
      for (const url of prioritized) enqueue(url, 1, false);
    }
  };

  const enqueue = (url: string, currentDepth: number, fromNav = false) => {
    const clean = normalizePageUrl(url);
    if (!clean) return;
    try { if (new URL(clean).origin !== origin) return; } catch { return; }
    if (shouldSkipPageUrl(clean, opts.url)) return;
    if (visitedPageVariants(clean).some((variant) => visited.has(variant))) return;
    if (visited.size >= opts.maxPages) return;
    visited.add(clean);

    const priority = linkEnqueuePriority(clean, fromNav);
    queue.add(async () => {
      if (records.length >= opts.maxPages) return;

      // Guard: skip URLs whose path extension is a known non-page type.
      // normalizePageUrl should catch these, but some URLs (sitemap entries,
      // JS-driven navigations) can arrive with encoded or unusual paths.
      const urlPathExt = extname(new URL(clean).pathname).toLowerCase();
      if (urlPathExt && NON_PAGE_EXTS.has(urlPathExt)) {
        logger.debug(`  [SKIP] ${clean}: non-page extension (${urlPathExt})`);
        return;
      }

      await new Promise((r) => setTimeout(r, NAV_DELAY_MS));

      let context: Awaited<ReturnType<typeof browser.newContext>> | null = null;
      try {
        context = await browser.newContext({
          userAgent: USER_AGENT,
          viewport: { width: 1440, height: 900 },
          ignoreHTTPSErrors: true,
          extraHTTPHeaders: {
            'Accept-Language': 'en-US,en;q=0.9',
          },
        });

        // Abort any navigation that triggers a file download — catches redirect
        // chains that resolve to PDFs or binaries not detectable by URL alone.
        context.on('download', (download) => {
          logger.debug(`  [SKIP] ${clean}: triggered a download (${download.suggestedFilename()})`);
          download.cancel().catch(() => {});
        });

        await context.addInitScript(() => {
          const collectNav = (value: unknown) => {
            try {
              if (typeof value !== 'string' && !(value instanceof URL)) return;
              const href = new URL(String(value), window.location.href).href;
              const key = '__clonyfyNavs';
              const store = window as unknown as Record<string, string[]>;
              const current = (store[key] ||= []);
              current.push(href);
              window.dispatchEvent(new CustomEvent('__cloner_nav__', { detail: href }));
            } catch {
              // Ignore invalid SPA route targets.
            }
          };
          const push = (window as Window).history.pushState.bind(history);
          const replace = (window as Window).history.replaceState.bind(history);
          (window as Window).history.pushState = function (...args) {
            push(...args);
            collectNav(args[2]);
          };
          (window as Window).history.replaceState = function (...args) {
            replace(...args);
            collectNav(args[2]);
          };
          window.addEventListener('popstate', () => collectNav(window.location.href));
        });

        logger.info(`  [${records.length + 1}/${opts.maxPages}] ${clean}`);
        const isStartUrl = !!startNorm && clean === startNorm;
        const captureTimeout = isStartUrl ? START_URL_CAPTURE_TIMEOUT : PAGE_CAPTURE_TIMEOUT;
        let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
        let timedOut = false;
        const capturePromise = capturePage(context, clean, assetsDir, hooks);
        const timeoutPromise = new Promise<never>((_, reject) => {
          timeoutHandle = setTimeout(() => {
            timedOut = true;
            context?.close().catch(() => {});
            reject(new Error(`Page capture timed out after ${captureTimeout / 1000}s`));
          }, captureTimeout);
        });
        let result: Awaited<typeof capturePromise>;
        try {
          result = await Promise.race([capturePromise, timeoutPromise]);
        } finally {
          if (timeoutHandle) clearTimeout(timeoutHandle);
          if (timedOut) {
            await Promise.race([
              capturePromise.catch(() => undefined),
              new Promise((resolve) => setTimeout(resolve, 2_000)),
            ]);
          }
        }

        const { record, links, navLinks = [] } = result;
        records.push(record);
        await Promise.resolve(onPage(record));

        if (currentDepth < opts.depth) {
          const navSet = new Set(navLinks);
          for (const link of navLinks) enqueue(link, currentDepth + 1, true);
          for (const link of new Set(links)) {
            if (!navSet.has(link)) enqueue(link, currentDepth + 1, false);
          }
        }
      } catch (err) {
        const errMsg = (err as Error).message || String(err);
        logger.warn(`  [SKIP] ${clean}: ${errMsg}`);
        // Start URL must not silently vanish — always try a static HTML salvage.
        // Hosted Shopify/marketing pages often OOM or timeout in Playwright.
        const isStartUrl = !!startNorm && clean === startNorm;
        if (isStartUrl || IS_SERVERLESS || IS_FAST_CLONE) {
          try {
            logger.info(`  [FALLBACK] Static HTML fetch for ${clean}`);
            const { record, links } = await fetchStaticPage(clean, origin, assetsDir);
            records.push(record);
            await Promise.resolve(onPage(record));
            if (currentDepth < opts.depth) {
              for (const link of links) enqueue(link, currentDepth + 1);
            }
          } catch (fallbackErr) {
            logger.warn(`  [FALLBACK FAIL] ${clean}: ${(fallbackErr as Error).message}`);
            if (isStartUrl) {
              // One more Playwright retry for the homepage only.
              try {
                logger.info(`  [RETRY] Playwright capture for start URL ${clean}`);
                await context?.close().catch(() => {});
                context = null;
                await new Promise((r) => setTimeout(r, 800));
                context = await browser.newContext({
                  userAgent: USER_AGENT,
                  viewport: { width: 1440, height: 900 },
                  ignoreHTTPSErrors: true,
                  extraHTTPHeaders: { 'Accept-Language': 'en-US,en;q=0.9' },
                });
                const retry = await capturePage(context, clean, assetsDir, hooks);
                records.push(retry.record);
                await Promise.resolve(onPage(retry.record));
              } catch (retryErr) {
                logger.warn(`  [RETRY FAIL] ${clean}: ${(retryErr as Error).message}`);
              }
            }
          }
        }
      } finally {
        if (startNorm && clean === startNorm) {
          startUrlFinished = true;
          maybeEnqueueSitemap();
        }
        await context?.close().catch(() => {});
      }
    }, { priority });
  };

  enqueue(opts.url, 0);

  logger.info('  Checking sitemap...');
  fetchSitemap(origin).then((urls) => {
    sitemapUrls = urls;
    sitemapFetchDone = true;
    maybeEnqueueSitemap();
  }).catch(() => {
    sitemapUrls = [];
    sitemapFetchDone = true;
    maybeEnqueueSitemap();
  });

  try {
    await queue.onIdle();
  } finally {
    await browser.close();
  }

  return records;
}
