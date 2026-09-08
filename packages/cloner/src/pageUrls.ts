import { extname } from 'path';

const TRACKING_PARAM = /^(utm_|fbclid|gclid|msclkid|_ga|_gl|mc_eid|yclid|dclid|zanpid|igshid|twclid|li_fat_id|ttclid)/i;

const NON_PAGE_EXTS = new Set([
  '.7z', '.aac', '.avi', '.avif', '.bin', '.bmp', '.css', '.csv', '.doc', '.docx',
  '.eot', '.exe', '.gif', '.gz', '.ico', '.jpeg', '.jpg', '.js', '.json', '.map',
  '.mjs', '.mov', '.mp3', '.mp4', '.ogg', '.ogv', '.otf', '.pdf', '.png', '.ppt',
  '.pptx', '.rar', '.rss', '.svg', '.tar', '.tgz', '.ttf', '.txt', '.wav', '.webm',
  '.webp', '.woff', '.woff2', '.xls', '.xlsx', '.xml', '.zip',
]);

const PAGE_EXTS = new Set([
  '.asp', '.aspx', '.htm', '.html', '.jsp', '.php', '.shtml', '.xhtml',
]);

export const AUTH_PATH = /^\/(login|logout|signin|sign-in|sign-out|signout|register|signup|sign-up|forgot-password|reset-password|change-password|verify-email|confirm-email|auth|oauth|sso|account\/activate|account\/confirm)(\/|$|\?)/i;

export function stripTrackingParams(href: string): string {
  try {
    const u = new URL(href);
    for (const key of [...u.searchParams.keys()]) {
      if (TRACKING_PARAM.test(key)) u.searchParams.delete(key);
    }
    return u.href;
  } catch {
    return href;
  }
}

export function normalizePageUrl(input: string, baseUrl?: string): string | null {
  const raw = String(input || '').trim();
  if (!raw || raw.startsWith('#')) return null;
  if (/^(mailto|tel|sms|javascript|data|blob):/i.test(raw)) return null;

  try {
    const u = new URL(raw, baseUrl);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    if (!u.hostname || ['http', 'https'].includes(u.hostname.toLowerCase())) return null;
    if (AUTH_PATH.test(u.pathname)) return null;

    u.hash = '';
    if (u.pathname === '/index.html') {
      u.pathname = '/';
    } else if (u.pathname !== '/' && u.pathname.endsWith('/')) {
      u.pathname = u.pathname.slice(0, -1);
    }

    const ext = extname(u.pathname).toLowerCase();
    if (NON_PAGE_EXTS.has(ext) && !PAGE_EXTS.has(ext)) return null;
    return stripTrackingParams(u.href);
  } catch {
    return null;
  }
}

export function isLikelyPageUrl(input: string, baseUrl?: string): boolean {
  return normalizePageUrl(input, baseUrl) !== null;
}
