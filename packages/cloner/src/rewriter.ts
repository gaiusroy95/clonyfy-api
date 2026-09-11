import * as parse5 from 'parse5';
import { rewriteCssUrls } from './capture.js';
import { FALLBACK_FONT_CSS, PLACEHOLDER_IMAGE_WEB_PATH } from './fallbackAssets.js';
import { logger } from './logger.js';
import type { PageRecord, AssetEntry } from './types.js';

function normalizeAssetLookupUrl(value: string): string {
  return String(value || '')
    .replace(/&amp;/gi, '&')
    .replace(/&quot;/gi, '"')
    .trim();
}

/**
 * Absolute http(s) media/font URL — only used when CLONYFY_PREFER_LIVE_MEDIA=1
 * (explicit opt-in hotlink mode). Default clone path always rewrites to /_assets.
 */
export function isPreferLiveMediaUrl(value: string): boolean {
  const raw = String(value || '').trim();
  if (!/^https?:\/\//i.test(raw)) return false;
  try {
    const path = new URL(raw).pathname.toLowerCase();
    return /\.(avif|bmp|gif|ico|jpe?g|png|svg|webp|mp4|webm|mov|m4v|ogg|ogv|mp3|wav|m4a|woff2?|ttf|otf|eot)(\?|$)/i.test(path)
      || /\/(_next\/image|cdn-cgi\/image|image\/upload|images\/|media\/|assets\/|static\/)/i.test(path);
  } catch {
    return false;
  }
}

/** Opt-in only. Default is rigorous local /_assets rewrite (no CDN hotlink). */
function preferLiveMediaEnabled(): boolean {
  const prefer = process.env.CLONYFY_PREFER_LIVE_MEDIA;
  return prefer === '1' || prefer === 'true';
}

function buildAssetMap(assets: AssetEntry[]): Map<string, string> {
  const m = new Map<string, string>();
  for (const a of assets) {
    const original = normalizeAssetLookupUrl(a.originalUrl);
    const variants = new Set<string>([
      a.originalUrl,
      original,
      original.split('?')[0].split('#')[0],
      a.originalUrl.split('?')[0].split('#')[0],
    ]);

    try {
      const u = new URL(original);
      variants.add(`${u.pathname}${u.search}${u.hash}`);
      variants.add(`${u.pathname}${u.search}`);
      variants.add(u.pathname);
      // Shopify CDN serves the same file under many width/quality query variants.
      if (/cdn\.shopify\.com$/i.test(u.hostname) || /shopifycdn|shopifycloud|myshopify/i.test(u.hostname)) {
        variants.add(u.pathname);
        const bare = new URL(u.href);
        bare.searchParams.delete('width');
        bare.searchParams.delete('height');
        bare.searchParams.delete('crop');
        bare.searchParams.delete('quality');
        variants.add(bare.href);
        variants.add(bare.pathname);
      }
    } catch { /* asset URL should be absolute, but keep rewriting tolerant */ }

    for (const key of variants) {
      if (key && key !== '/') m.set(key, a.localPath);
    }
  }
  return m;
}

function rewriteUrl(value: string, assetMap: Map<string, string>, baseUrl: string): string {
  if (!value) return value;
  const decoded = normalizeAssetLookupUrl(value);

  // Explicit opt-in: keep live absolute media URLs (hotlink; CORS-sensitive).
  if (preferLiveMediaEnabled() && isPreferLiveMediaUrl(decoded)) {
    return decoded;
  }

  const clean = decoded.split('?')[0].split('#')[0];

  // Direct lookup (absolute URL already in map) — prefer local /_assets always.
  if (assetMap.has(value)) return assetMap.get(value)!;
  if (assetMap.has(decoded)) return assetMap.get(decoded)!;
  if (assetMap.has(clean)) return assetMap.get(clean)!;

  // Resolve root-relative and document-relative paths against origin, then look up
  try {
    const abs = new URL(decoded, baseUrl).href;
    if (preferLiveMediaEnabled() && isPreferLiveMediaUrl(abs)) {
      return abs;
    }
    const absClean = abs.split('?')[0].split('#')[0];
    if (assetMap.has(abs)) return assetMap.get(abs)!;
    if (assetMap.has(absClean)) return assetMap.get(absClean)!;
    // CDN images often differ only by width/quality query params — match by pathname.
    const pathname = new URL(abs).pathname;
    if (assetMap.has(pathname)) return assetMap.get(pathname)!;
    for (const [key, localPath] of assetMap) {
      try {
        if (new URL(normalizeAssetLookupUrl(key), abs).pathname === pathname) return localPath;
      } catch {
        if (key.endsWith(pathname)) return localPath;
      }
    }
    // Same-origin but not captured as asset — convert to relative path so links still work
    const u = new URL(abs);
    if (u.origin === new URL(baseUrl).origin) {
      if (preferLiveMediaEnabled() && isPreferLiveMediaUrl(abs)) return abs;
      return u.pathname + u.search + u.hash;
    }
  } catch { /* not a URL */ }

  return value;
}

const URL_ATTRS: Record<string, string[]> = {
  '': ['src', 'href', 'action', 'data-src', 'data-href', 'data-url', 'data-lazy-src',
       'data-image', 'data-bg', 'data-background', 'data-video', 'data-poster',
       'data-original', 'data-master', 'poster', 'srcset', 'imagesrcset', 'style'],
  'link': ['href'],
  'use': ['href', 'xlink:href'],
  'image': ['href', 'xlink:href'],
};

const META_IMAGE_PROPERTIES = new Set([
  'og:image',
  'og:image:url',
  'og:image:secure_url',
  'twitter:image',
  'twitter:image:src',
]);

// iframe src patterns that should be blanked — map/chat embeds that require live network
const MAP_EMBED_PATTERNS = [
  /openstreetmap\.org\/export\/embed/,
  /maps\.google\.com\/maps/,
  /google\.com\/maps\/embed/,
  /bing\.com\/maps\/embed/,
  /yandex\.\w+\/map-widget/,
  /2gis\.com\/widget/,
  /maps\.apple\.com/,
];
function isMapIframe(src: string): boolean {
  return MAP_EMBED_PATTERNS.some((p) => p.test(src));
}

const IMAGE_URL_ATTRS = new Set([
  'src', 'data-src', 'data-lazy-src', 'data-original', 'data-image', 'data-master', 'poster', 'srcset', 'data-srcset',
]);

function assetMapHasUrl(assetMap: Map<string, string>, value: string, baseUrl: string): boolean {
  const decoded = normalizeAssetLookupUrl(value);
  if (assetMap.has(value) || assetMap.has(decoded)) return true;
  const clean = decoded.split('?')[0].split('#')[0];
  if (assetMap.has(clean)) return true;
  try {
    const abs = new URL(decoded, baseUrl).href;
    const absClean = abs.split('?')[0].split('#')[0];
    if (assetMap.has(abs) || assetMap.has(absClean)) return true;
    const pathname = new URL(abs).pathname;
    if (assetMap.has(pathname)) return true;
    for (const key of assetMap.keys()) {
      try {
        if (new URL(normalizeAssetLookupUrl(key), abs).pathname === pathname) return true;
      } catch {
        if (key.endsWith(pathname)) return true;
      }
    }
  } catch { /* not a URL */ }
  return false;
}

/**
 * Only treat as "failed" when capture explicitly marked the URL broken.
 * Unmapped external media are left as-is (surfaced via failedAssets when known).
 */
function isUnresolvedExternalImage(
  _value: string,
  _baseUrl: string,
  _origin: string,
  _assetMap: Map<string, string>,
): boolean {
  return false;
}

const LIVE_WIDGET_PATTERNS = [
  /js\.hs-scripts\.com/,
  /js-[a-z0-9]+\.hs-scripts\.com/,
  /js-[a-z0-9]+\.hsforms\.net\/forms\//,
  /forms-[a-z0-9]+\.hsforms\.com\//,
  /static\.hsappstatic\.net\/ui-forms-embed-components-app\//,
  /hubspotv2\.[^/]+\.webflow\.services\/static\//,
];
function isLiveWidgetUrl(src: string): boolean {
  return LIVE_WIDGET_PATTERNS.some((p) => p.test(src));
}

function isMetaImageContent(el: parse5.DefaultTreeAdapterMap['element']): boolean {
  const key = el.attrs?.find((a) => a.name.toLowerCase() === 'property' || a.name.toLowerCase() === 'name')
    ?.value.toLowerCase();
  return !!key && META_IMAGE_PROPERTIES.has(key);
}

function rewriteAttrValue(
  name: string,
  value: string,
  assetMap: Map<string, string>,
  baseUrl: string,
): string {
  if (!value) return value;

  if (name === 'srcset' || name === 'imagesrcset') {
    return value.split(',').map((part) => {
      const trimmed = part.trim();
      const spaceIdx = trimmed.search(/\s/);
      if (spaceIdx === -1) return rewriteUrl(trimmed, assetMap, baseUrl);
      const url = trimmed.slice(0, spaceIdx);
      const descriptor = trimmed.slice(spaceIdx);
      return rewriteUrl(url, assetMap, baseUrl) + descriptor;
    }).join(', ');
  }

  if (name === 'style') {
    return value
      .replace(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/g, (match, quote, url) => {
        const rewritten = rewriteUrl(url, assetMap, baseUrl);
        return `url(${quote}${rewritten}${quote})`;
      })
      // Inline image-set() bare strings (url() forms handled above).
      .replace(/(-webkit-)?image-set\(((?:[^()]|\([^()]*\))*)\)/gi, (match, prefix, inner) => {
        const newInner = inner.replace(/(['"])([^'"]+)\1/g, (m: string, q: string, url: string) => {
          if (!url.includes('/') || url.startsWith('image/')) return m;
          return `${q}${rewriteUrl(url, assetMap, baseUrl)}${q}`;
        });
        return `${prefix || ''}image-set(${newInner})`;
      });
  }

  return rewriteUrl(value, assetMap, baseUrl);
}

interface RewriteStats {
  attrsRewritten: number;
  attrsToRelative: number;   // same-origin links converted to relative (not assets, just nav links)
  styleUrlsRewritten: number;
  externalUrls: number;      // pointing to other origins — left as-is intentionally
  inlineScriptUrlsRewritten: number;
}

function toEscapedSlash(value: string): string {
  return value.replace(/\//g, '\\/');
}

function toUnicodeEscapedSlash(value: string): string {
  return value.replace(/\//g, '\\u002F');
}

function replaceAllLiteral(input: string, search: string, replacement: string): string {
  return search ? input.split(search).join(replacement) : input;
}

function rewriteInlineAssetReferences(text: string, assetMap: Map<string, string>): string {
  let output = text;
  const entries = [...assetMap.entries()]
    .filter(([from, to]) => from.length > 1 && to && from !== to)
    .sort((a, b) => b[0].length - a[0].length);

  for (const [from, to] of entries) {
    if (preferLiveMediaEnabled() && isPreferLiveMediaUrl(from)) continue;
    output = replaceAllLiteral(output, from, to);

    const escapedFrom = toEscapedSlash(from);
    if (escapedFrom !== from) {
      output = replaceAllLiteral(output, escapedFrom, toEscapedSlash(to));
    }

    const unicodeEscapedFrom = toUnicodeEscapedSlash(from);
    if (unicodeEscapedFrom !== from) {
      output = replaceAllLiteral(output, unicodeEscapedFrom, toUnicodeEscapedSlash(to));
    }
  }

  return output;
}

function walkNode(
  node: parse5.DefaultTreeAdapterMap['childNode'],
  assetMap: Map<string, string>,
  origin: string,
  baseUrl: string,
  stats: RewriteStats,
  failedAssets: Set<string>,
): void {
  if (node.nodeName === '#text' || node.nodeName === '#comment' || node.nodeName === '#document') return;

  const el = node as parse5.DefaultTreeAdapterMap['element'];
  const tagName = el.nodeName?.toLowerCase() ?? '';

  // Blank out live embeds so they don't make network requests in the clone.
  if (tagName === 'iframe' && el.attrs) {
    const srcAttr = el.attrs.find((a) => a.name === 'src');
    if (srcAttr?.value && (isMapIframe(srcAttr.value) || isLiveWidgetUrl(srcAttr.value))) {
      const originalSrc = srcAttr.value;
      srcAttr.value = 'about:blank';
      el.attrs = el.attrs.filter((a) => a.name !== 'allowfullscreen' && a.name !== 'loading');
      logger.debug(`  [LIVE IFRAME] replaced ${originalSrc} with about:blank`);
      stats.attrsRewritten++;
    }
  }

  if (tagName === 'style' && el.childNodes) {
    for (const child of el.childNodes) {
      if (child.nodeName === '#text') {
        const textNode = child as parse5.DefaultTreeAdapterMap['textNode'];
        const before = textNode.value;
        textNode.value = rewriteCssUrls(before, assetMap, baseUrl);
        if (textNode.value !== before) stats.styleUrlsRewritten++;
      }
    }
  }

  if (tagName === 'script' && el.childNodes) {
    for (const child of el.childNodes) {
      if (child.nodeName === '#text') {
        const textNode = child as parse5.DefaultTreeAdapterMap['textNode'];
        const before = textNode.value;
        textNode.value = rewriteInlineAssetReferences(before, assetMap);
        if (textNode.value !== before) stats.inlineScriptUrlsRewritten++;
      }
    }
  }

  if (el.attrs) {
    const urlAttrs = new Set([
      ...(URL_ATTRS[''] ?? []),
      ...(URL_ATTRS[tagName] ?? []),
    ]);
    if (tagName === 'meta' && isMetaImageContent(el)) {
      urlAttrs.add('content');
    }

    let rewroteSubresourceToLocal = false;
    for (const attr of el.attrs) {
      const attrName = attr.name.toLowerCase();
      if (urlAttrs.has(attrName) && attr.value) {
        const before = attr.value;

        if ((tagName === 'script' || tagName === 'iframe') && isLiveWidgetUrl(before)) {
          attr.value = tagName === 'iframe' ? 'about:blank' : '';
          stats.attrsRewritten++;
          continue;
        }

        // Prefer a successfully captured local file over failedAssets placeholders.
        try {
          const absUrl = new URL(before, baseUrl).href;
          if (assetMapHasUrl(assetMap, before, baseUrl) || assetMapHasUrl(assetMap, absUrl, baseUrl)) {
            attr.value = rewriteAttrValue(attrName, attr.value, assetMap, baseUrl);
            if (attr.value !== before) {
              stats.attrsRewritten++;
              if ((tagName === 'link' || tagName === 'script') && attr.value.includes('/_assets/')) {
                rewroteSubresourceToLocal = true;
              }
            }
            continue;
          }
          const failed = failedAssets.has(absUrl) || failedAssets.has(before);
          const unresolvedExternalImage = !failed
            && IMAGE_URL_ATTRS.has(attrName)
            && (tagName === 'img' || tagName === 'source' || tagName === 'video')
            && isUnresolvedExternalImage(before, baseUrl, origin, assetMap);
          if (failed || unresolvedExternalImage) {
            attr.value = PLACEHOLDER_IMAGE_WEB_PATH;
            stats.attrsRewritten++;
            continue;
          }
        } catch { /* not a URL, continue rewriting */ }

        attr.value = rewriteAttrValue(attrName, attr.value, assetMap, baseUrl);
        if (attr.value !== before) {
          stats.attrsRewritten++;
          if ((tagName === 'link' || tagName === 'script') && attr.value.includes('/_assets/')) {
            rewroteSubresourceToLocal = true;
          }
        } else {
          try {
            const u = new URL(before, baseUrl);
            if (u.origin !== origin && u.protocol.startsWith('http')) {
              stats.externalUrls++;
            } else if (u.origin === origin) {
              stats.attrsToRelative++;
            }
          } catch { /* not a URL */ }
        }
      }
    }
    if (rewroteSubresourceToLocal) {
      el.attrs = el.attrs.filter((a) => a.name.toLowerCase() !== 'integrity');
    }
  }

  if ('childNodes' in el && el.childNodes) {
    for (const child of el.childNodes) {
      walkNode(child, assetMap, origin, baseUrl, stats, failedAssets);
    }
  }
}

function preprocessHtml(html: string): string {
  // Remove <base> tags entirely — rewriting them to <base href="/"> breaks anchor-hash links
  // on subpages (e.g. <a href="#section"> navigates to /#section instead of /current-path#section).
  html = html.replace(/<base\s[^>]*\/?>/gi, '').replace(/<base\s*\/>/gi, '').replace(/<base>/gi, '');
  // Remove Content-Security-Policy meta tags — the original site's CSP allowlists its own CDN
  // domains but not the clone server, which would block /_assets/ resources in the browser.
  html = html.replace(/<meta\s[^>]*\bhttp-equiv\s*=\s*["']?content-security-policy["']?[^>]*\/?>/gi, '');
  // Remove X-Frame-Options meta (rare but safe to strip)
  html = html.replace(/<meta\s[^>]*\bhttp-equiv\s*=\s*["']?x-frame-options["']?[^>]*\/?>/gi, '');
  return html;
}

function injectFallbackStyles(html: string): string {
  if (html.includes('clonyfy-fallback-fonts')) return html;
  const styleTag = `<style id="clonyfy-fallback-fonts">${FALLBACK_FONT_CSS}</style>`;
  if (/<head\b/i.test(html)) {
    return html.replace(/<head\b([^>]*)>/i, `<head$1>${styleTag}`);
  }
  return `${styleTag}${html}`;
}

export function rewriteHtml(record: PageRecord, origin: string): string {
  const assetMap = buildAssetMap(record.assets);
  const failedAssets = new Set<string>(record.failedAssets ?? []);
  const stats: RewriteStats = {
    attrsRewritten: 0,
    attrsToRelative: 0,
    styleUrlsRewritten: 0,
    externalUrls: 0,
    inlineScriptUrlsRewritten: 0,
  };
  const baseUrl = record.url || origin;

  const doc = parse5.parse(preprocessHtml(record.html));
  for (const child of doc.childNodes) {
    walkNode(child, assetMap, origin, baseUrl, stats, failedAssets);
  }

  logger.debug(
    `  [REWRITE] ${record.url}\n` +
    `    attrs_rewritten_to_assets=${stats.attrsRewritten}  style_blocks_rewritten=${stats.styleUrlsRewritten}  inline_scripts_rewritten=${stats.inlineScriptUrlsRewritten}\n` +
    `    attrs_converted_to_relative=${stats.attrsToRelative}  external_urls_unchanged=${stats.externalUrls}`,
  );

  return injectFallbackStyles(parse5.serialize(doc));
}
