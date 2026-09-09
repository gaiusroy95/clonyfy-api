import { createServer } from 'http';
import { spawn } from 'child_process';
import { randomUUID, createHash, createHmac, timingSafeEqual } from 'crypto';
import { resolve, join, dirname, relative } from 'path';
import { fileURLToPath } from 'url';
import { readFileSync, writeFileSync, existsSync, readdirSync, statSync, mkdirSync, rmSync, createReadStream, createWriteStream, copyFileSync, openSync, closeSync, readSync } from 'fs';
import { request as httpsRequest } from 'https';
import { lookup as dnsLookup } from 'dns/promises';
import { createRequire } from 'module';
import { tmpdir } from 'os';
import 'dotenv/config';
import { runClone, regenerateCloneProject } from './packages/cloner/dist/runClone.js';
import {
  getUserById, getUserByEmail, getAllUsers, getUsersPage, getClonesByUserIds, insertUser, updateUser, deleteUser,
  getUserByVerifyToken, getUserByResetToken,
  getUserByGoogleId, getUserByStripeCustomerId, insertOAuthUser,
  getSession, insertSession, deleteSession, deleteUserSessions, cleanExpiredSessions,
  insertClone, updateCloneLabel, updateCloneStatus, getClonesByUser, getAllClones, deleteCloneById, deleteUserClones, getCloneCountThisMonth,
  getAllPayments, getPaymentsByUser, getPaymentById, insertPayment, updatePayment, getPendingPaymentByUserPlan, getAdminStats,
  getSettings, saveSettings,
  getUserBlockReason, getUserBlockReasons, setUserBlockReason,
  getShare, insertShare, insertUsageEvent, countUsageEventsSince,
  getAllPromoCodes, getPromoCode, insertPromoCode, incrementPromoUsed, deletePromoCode,
  getAllErrors, insertError, deleteError, clearErrors, pruneErrors,
  insertAudit, getAuditLog, getAuditCount, pruneAuditLog, audit,
  insertAnnouncement, getAllAnnouncements,
  insertContactSubmission, getContactSubmissions,
  getCloneByOutDir, uploadCloneFile, downloadCloneFile, saveCloneTextFile, getCloneTextFile,
  createCloneFileSignedUrl, uploadExportZipForDownload, isStorageSizeLimitError,
  getAffiliateOwnerBySlug, saveAffiliateSlug, getAffiliateReferrals, addAffiliateReferral, getAffiliateVisits, addAffiliateVisit,
} from './db.js';
import { htmlToFigmaSvg, htmlToFigmaScene, exportCloneToFigmaZip, routeToSvgFilename } from './lib/figmaExport.js';
import { svgToFigmaScene, slimFigmaSceneForTransport } from './lib/figmaSceneGraph.js';
import { buildVisibilityPatchHtml, buildScrollAnimationsPatchHtml } from './lib/cloneServePatches.js';

const _cjsRequire = createRequire(import.meta.url);
let bcrypt = null, nodemailer = null, StripeLib = null;
try { bcrypt = _cjsRequire('bcryptjs'); } catch {}
try { nodemailer = _cjsRequire('nodemailer'); } catch {}
try { StripeLib = _cjsRequire('stripe'); } catch {}

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLI = join(__dirname, 'packages', 'cloner', 'dist', 'cli.js');
const EMAILS_DIR = join(__dirname, 'templates', 'emails');
const PORT = process.env.PORT ? parseInt(process.env.PORT) : 5000;
const RENDER_EXTERNAL_URL = String(process.env.RENDER_EXTERNAL_URL || '').replace(/\/$/, '');
const DEFAULT_APP_URL = (
  process.env.APP_URL
  || RENDER_EXTERNAL_URL
  || `http://localhost:${PORT}`
).replace(/\/$/, '');
// Only use an explicit override — never hardcode production domain on preview deploys.
const CANONICAL_APP_URL = (process.env.PUBLIC_APP_URL || process.env.SHARE_BASE_URL || '').replace(/\/$/, '');
const DEFAULT_AFFONSO_PUBLIC_ID = 'cmpj1i5tn00087mxngp80ddzy';

const jobs = new Map();
const ACTIVE_JOB_STATUSES = new Set(['running', 'saving']);
const isActiveJob = (job) => ACTIVE_JOB_STATUSES.has(job?.status);

// ── Security constants ────────────────────────────────────────────────────────
// Set PASSWORD_PEPPER and SHARE_PASSWORD_PEPPER in your .env file.
// Defaults keep backward-compatibility with existing password hashes.
const PASSWORD_PEPPER = process.env.PASSWORD_PEPPER || 'wc_secret_2025';
const SHARE_PASSWORD_PEPPER = process.env.SHARE_PASSWORD_PEPPER || 'wc_share_2025';
if (PASSWORD_PEPPER === 'wc_secret_2025') {
  console.warn('[WARN] PASSWORD_PEPPER is not set — using insecure default. Add PASSWORD_PEPPER=<random> to .env');
}

// ── Admin ─────────────────────────────────────────────────────────────────────
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD;
if (!ADMIN_PASSWORD) { console.error('[FATAL] ADMIN_PASSWORD env var is not set. Admin login is disabled.'); }

// Admin sessions persisted to disk so they survive server restarts.
const ADMIN_SESSIONS_FILE = join(__dirname, '.admin-sessions.json');
const adminSessions = new Map(); // token → expiresAt
const ADMIN_TOKEN_TTL_MS = 8 * 3600 * 1000;

function base64UrlEncode(input) {
  return Buffer.from(input).toString('base64url');
}

function base64UrlDecode(input) {
  return Buffer.from(String(input || ''), 'base64url').toString('utf8');
}

function signAdminPayload(payload) {
  return createHmac('sha256', `${ADMIN_PASSWORD || ''}:${PASSWORD_PEPPER}`)
    .update(payload)
    .digest('base64url');
}

function createAdminToken() {
  const payload = base64UrlEncode(JSON.stringify({
    exp: Date.now() + ADMIN_TOKEN_TTL_MS,
    nonce: randomUUID(),
  }));
  return `adm1.${payload}.${signAdminPayload(payload)}`;
}

function verifySignedAdminToken(token) {
  if (!ADMIN_PASSWORD || !String(token || '').startsWith('adm1.')) return false;
  const parts = String(token).split('.');
  if (parts.length !== 3 || !parts[1] || !parts[2]) return false;
  const expected = signAdminPayload(parts[1]);
  const got = Buffer.from(parts[2]);
  const exp = Buffer.from(expected);
  if (got.length !== exp.length || !timingSafeEqual(got, exp)) return false;
  try {
    const payload = JSON.parse(base64UrlDecode(parts[1]));
    return Number(payload.exp || 0) > Date.now();
  } catch {
    return false;
  }
}

function _loadAdminSessions() {
  try {
    if (!existsSync(ADMIN_SESSIONS_FILE)) return;
    const raw = JSON.parse(readFileSync(ADMIN_SESSIONS_FILE, 'utf8'));
    const now = Date.now();
    for (const [token, exp] of Object.entries(raw)) {
      if (exp > now) adminSessions.set(token, exp);
    }
    if (adminSessions.size) console.log(`[Admin] Restored ${adminSessions.size} active admin session(s).`);
  } catch { /* first run or corrupted file — start fresh */ }
}

function _persistAdminSessions() {
  try {
    const now = Date.now();
    const out = {};
    for (const [token, exp] of adminSessions) {
      if (exp > now) out[token] = exp;
    }
    writeFileSync(ADMIN_SESSIONS_FILE, JSON.stringify(out), 'utf8');
  } catch (e) { console.warn('[Admin] Could not persist sessions:', e.message); }
}

_loadAdminSessions();

function isAdmin(req) {
  const t = req.headers['x-admin-token'] || '';
  if (!t) return false;
  if (verifySignedAdminToken(t)) return true;
  const exp = adminSessions.get(t);
  if (!exp) return false;
  if (Date.now() > exp) { adminSessions.delete(t); _persistAdminSessions(); return false; }
  return true;
}
setInterval(() => {
  const now = Date.now();
  let changed = false;
  for (const [k, v] of adminSessions) { if (now > v) { adminSessions.delete(k); changed = true; } }
  if (changed) _persistAdminSessions();
}, 3600000);

// ── Rate limiting ──────────────────────────────────────────────────────────────
const rateLimits = new Map();
function checkRateLimit(key, maxReq = 10, windowMs = 60000) {
  const now = Date.now();
  let rl = rateLimits.get(key);
  if (!rl || now > rl.resetAt) { rl = { count: 0, resetAt: now + windowMs }; }
  rl.count++;
  rateLimits.set(key, rl);
  return rl.count <= maxReq;
}
setInterval(() => { const now = Date.now(); for (const [k, v] of rateLimits) { if (now > v.resetAt) rateLimits.delete(k); } }, 300000);
setInterval(async () => { try { await cleanExpiredSessions(Date.now()); } catch {} }, 3600000);
setInterval(async () => { try { await pruneAuditLog(); } catch {} }, 3600000);
// Evict finished jobs older than 4 hours from memory; they remain in DB and on disk.
setInterval(() => {
  const cutoff = Date.now() - 4 * 60 * 60 * 1000;
  for (const [id, job] of jobs) {
    if (!isActiveJob(job) && new Date(job.startedAt).getTime() < cutoff) {
      jobs.delete(id);
    }
  }
}, 3600000);

// ── Plan limits ────────────────────────────────────────────────────────────────
const PLAN_LIMITS = {
  free:       { clonesPerMonth: 3,        maxPages: 20,  fullSite: false, editsPerMonth: 2,  savesPerMonth: 2,  sharesPerMonth: 2  },
  starter:    { clonesPerMonth: 10,       maxPages: 500, fullSite: false, editsPerMonth: Infinity, savesPerMonth: Infinity, sharesPerMonth: 25 },
  growth:     { clonesPerMonth: 25,       maxPages: 500, fullSite: false, editsPerMonth: Infinity, savesPerMonth: Infinity, sharesPerMonth: Infinity },
  unlimited:  { clonesPerMonth: Infinity, maxPages: 500, fullSite: true,  editsPerMonth: Infinity, savesPerMonth: Infinity, sharesPerMonth: Infinity },
};
const USAGE_KIND_LIMIT_KEY = { edit: 'editsPerMonth', save: 'savesPerMonth', share: 'sharesPerMonth' };
const PAID_PLAN_KEYS = ['starter', 'growth', 'unlimited'];
const PLAN_ALIASES = { popular: 'growth', pro: 'growth', scale: 'unlimited', enterprise: 'unlimited' };
const LEGACY_PAID_PLAN_KEYS = Object.keys(PLAN_ALIASES);
const ALL_PAID_PLAN_KEYS = [...PAID_PLAN_KEYS, ...LEGACY_PAID_PLAN_KEYS];
const IS_RENDER = !!(process.env.RENDER || process.env.RENDER_EXTERNAL_URL);
/** Opt-in serverless mode (Lambda-style). Render is a dedicated Node host — leave unset. */
const IS_SERVERLESS = process.env.CLONYFY_SERVERLESS === '1' || process.env.CLONYFY_SERVERLESS === 'true';
/** Production / Render: serve clone preview via /api/page instead of spawning local Next. */
const IS_HOSTED = IS_RENDER
  || process.env.CLONYFY_HOSTED === '1'
  || process.env.NODE_ENV === 'production';
/**
 * Low-memory / Free-tier mode: prefer concurrency 1 and softer exports.
 * Auto-on for Render unless CLONYFY_LOW_MEMORY=0.
 */
const IS_LOW_MEMORY = process.env.CLONYFY_LOW_MEMORY === '1'
  || process.env.CLONYFY_LOW_MEMORY === 'true'
  || (IS_RENDER && process.env.CLONYFY_LOW_MEMORY !== '0' && process.env.CLONYFY_LOW_MEMORY !== 'false');
/** Inline clone only for serverless (no child process). Render/dedicated hosts spawn the CLI so /api/clone returns immediately and the UI can poll. */
const USE_INLINE_CLONE = IS_SERVERLESS || process.env.CLONYFY_INLINE_CLONE === '1';
/** Parallel page capture (1–4). Hosted Free defaults to 1 to avoid OOM during Chromium crawl. */
const CLONE_CONCURRENCY = Math.max(1, Math.min(4, parseInt(
  process.env.CLONYFY_CLONE_CONCURRENCY || (IS_HOSTED ? (IS_LOW_MEMORY ? '1' : '2') : '1'),
  10,
) || (IS_HOSTED && !IS_LOW_MEMORY ? 2 : 1)));
/** Wall-clock limit so jobs cannot spin 60+ minutes with no usable result. */
const CLONE_DEADLINE_MS = Math.max(
  5 * 60 * 1000,
  parseInt(process.env.CLONYFY_CLONE_DEADLINE_MS || String((IS_LOW_MEMORY ? 12 : 18) * 60 * 1000), 10)
    || ((IS_LOW_MEMORY ? 12 : 18) * 60 * 1000),
);
const SERVERLESS_MAX_PAGES = Math.max(1, parseInt(process.env.CLONYFY_SERVERLESS_MAX_PAGES || '500', 10) || 500);
/** Safety ceiling for Scale "Select all pages" (same-origin deep crawl). Raise on dedicated hosts. */
const FULL_SITE_MAX_PAGES = Math.max(500, parseInt(process.env.CLONYFY_FULL_SITE_MAX_PAGES || '10000', 10) || 10000);
const FULL_SITE_DEPTH = Math.max(50, parseInt(process.env.CLONYFY_FULL_SITE_DEPTH || '256', 10) || 256);
const SERVERLESS_FULL_SITE_MAX_PAGES = Math.max(1, parseInt(process.env.CLONYFY_SERVERLESS_FULL_SITE_MAX_PAGES || String(SERVERLESS_MAX_PAGES), 10) || SERVERLESS_MAX_PAGES);
const PLAN_PRICES = {
  starter:    { monthly: 19.99, annual: 191.88 },
  growth:     { monthly: 29.99, annual: 287.88 },
  unlimited:  { monthly: 59.99, annual: 575.88 },
};
const PLAN_LABELS = {
  free: 'Free',
  starter: 'Starter',
  growth: 'Growth',
  unlimited: 'Scale',
};
function legacyAliasesForPlan(plan) {
  const normalized = normalizePlan(plan);
  return Object.keys(PLAN_ALIASES).filter(alias => PLAN_ALIASES[alias] === normalized);
}
function normalizePlan(plan) {
  const key = String(plan || 'free').toLowerCase();
  return PLAN_ALIASES[key] || (PLAN_LIMITS[key] ? key : 'free');
}
function isPaidPlan(plan) {
  return normalizePlan(plan) !== 'free';
}
function getPlanLimits(plan) {
  return PLAN_LIMITS[normalizePlan(plan)] || PLAN_LIMITS.free;
}
function getEffectivePlanLimits(plan) {
  const limits = getPlanLimits(plan);
  const maxPages = IS_SERVERLESS ? Math.min(limits.maxPages, SERVERLESS_MAX_PAGES) : limits.maxPages;
  const fullSiteAllowed = limits.fullSite === true;
  const fullSiteMaxPages = IS_SERVERLESS
    ? Math.min(FULL_SITE_MAX_PAGES, SERVERLESS_FULL_SITE_MAX_PAGES)
    : FULL_SITE_MAX_PAGES;
  return {
    ...limits,
    maxPages,
    fullSiteAllowed,
    fullSiteMaxPages,
    fullSiteDepth: FULL_SITE_DEPTH,
  };
}
function finiteLimit(value) {
  return value === Infinity ? null : value;
}
function usageLimitLabel(kind) {
  return { edit: 'editor sessions', save: 'saves', share: 'share links' }[kind] || kind;
}
function usageLimitError(kind, used, limit) {
  return `Monthly ${usageLimitLabel(kind)} limit reached (${used}/${limit}). Upgrade for more.`;
}
async function getUserUsageSummary(user) {
  const plan = normalizePlan(user.plan);
  const limits = getEffectivePlanLimits(plan);
  const periodStart = planPeriodStart(user).toISOString();
  const [editsThisMonth, savesThisMonth, sharesThisMonth, clonesThisMonth] = await Promise.all([
    countUsageEventsSince(user.id, 'edit', periodStart),
    countUsageEventsSince(user.id, 'save', periodStart),
    countUsageEventsSince(user.id, 'share', periodStart),
    getCloneCountThisMonth(user.id, periodStart),
  ]);
  return {
    periodStart,
    editsThisMonth,
    savesThisMonth,
    sharesThisMonth,
    clonesThisMonth,
    limits: {
      clonesPerMonth: finiteLimit(limits.clonesPerMonth),
      maxPages: limits.maxPages,
      fullSiteAllowed: !!limits.fullSiteAllowed,
      fullSiteMaxPages: limits.fullSiteMaxPages,
      fullSiteDepth: limits.fullSiteDepth,
      editsPerMonth: finiteLimit(limits.editsPerMonth),
      savesPerMonth: finiteLimit(limits.savesPerMonth),
      sharesPerMonth: finiteLimit(limits.sharesPerMonth),
    },
  };
}
async function consumeUsageQuota(user, kind, { outDir, record = true } = {}) {
  const limits = getEffectivePlanLimits(normalizePlan(user.plan));
  const limitKey = USAGE_KIND_LIMIT_KEY[kind];
  const limit = limitKey ? limits[limitKey] : Infinity;
  if (limit === Infinity) return { allowed: true, used: 0, limit: null };
  const periodStart = planPeriodStart(user).toISOString();
  const used = await countUsageEventsSince(user.id, kind, periodStart);
  if (used >= limit) {
    return { allowed: false, used, limit, error: usageLimitError(kind, used, limit) };
  }
  if (!record) return { allowed: true, used, limit };
  await insertUsageEvent({
    id: randomUUID(),
    userId: user.id,
    kind,
    outDir: outDir || null,
    createdAt: new Date().toISOString(),
  });
  return { allowed: true, used: used + 1, limit };
}

// Usage window: limits are MONTHLY (calendar month reloads on the 1st) AND
// reset on plan change (after an upgrade, "previous" usage doesn't count
// against the new plan).
//
// Window start = max(calendar month start, plan activation timestamp).
//   - Free user, no plan change this month: window = month start ✅
//   - Mid-month upgrade (e.g. 3/3 → buy 10-clone plan): activation is AFTER
//     month start, so window = activation time → counter shows 0/10 ✅
//   - Next calendar month after upgrade: month start is AFTER activation, so
//     window = month start → 0/10 again, fresh monthly quota ✅
//
// Plan activation timestamp is derived from plan_renews_at - billing_interval
// (set by activatePaidPlanForUser on every paid-plan change/renewal).
function planPeriodStart(user) {
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  if (!user || !user.plan_renews_at) return monthStart;
  const renews = new Date(user.plan_renews_at);
  if (Number.isNaN(renews.getTime())) return monthStart;
  const activated = new Date(renews);
  if (user.billing_interval === 'annual') activated.setFullYear(activated.getFullYear() - 1);
  else activated.setMonth(activated.getMonth() - 1);
  if (activated.getTime() > Date.now()) return monthStart; // future renews_at quirk
  // max(monthStart, activated): later of the two — monthly reset + upgrade reset
  return activated.getTime() > monthStart.getTime() ? activated : monthStart;
}
function getPlanPrices(plan) {
  return PLAN_PRICES[normalizePlan(plan)] || { monthly: 0, annual: 0 };
}
function getPlanLabel(plan) {
  return PLAN_LABELS[normalizePlan(plan)] || 'Free';
}
function planFromStripePriceId(priceId) {
  if (!priceId) return 'free';
  const s = getStripeSettings();
  for (const plan of ALL_PAID_PLAN_KEYS) {
    const normalized = normalizePlan(plan);
    for (const interval of ['monthly', 'annual']) {
      if (s[STRIPE_PRICE_KEY(plan, interval)] === priceId) return normalized;
    }
  }
  return 'free';
}
async function activatePaidPlanForUser(userId, { plan, interval = 'monthly', renewsAt = null, stripeSubscriptionId = null, cancelAtPeriodEnd = 0 } = {}) {
  const confirmedPlan = normalizePlan(plan);
  if (!isPaidPlan(confirmedPlan)) return null;
  const fields = {
    plan: confirmedPlan,
    billing_interval: interval === 'annual' ? 'annual' : 'monthly',
    renewal_reminder_sent: 0,
    usage_alert_sent: 0,
    cancel_at_period_end: cancelAtPeriodEnd ? 1 : 0,
  };
  if (renewsAt) fields.plan_renews_at = renewsAt instanceof Date ? renewsAt.toISOString() : String(renewsAt);
  if (stripeSubscriptionId) fields.stripe_subscription_id = stripeSubscriptionId;
  await updateUser(userId, fields);
  _invalidateUserSessions(userId);
  return confirmedPlan;
}
function stripeSubscriptionPlan(sub, fallbackPlan = 'free') {
  const metaPlan = normalizePlan(sub?.metadata?.plan || fallbackPlan);
  if (isPaidPlan(metaPlan)) return metaPlan;
  for (const item of sub?.items?.data || []) {
    const price = item?.price;
    const pricePlan = normalizePlan(price?.metadata?.plan || planFromStripePriceId(price?.id));
    if (isPaidPlan(pricePlan)) return pricePlan;
  }
  return 'free';
}

// ── Auth ──────────────────────────────────────────────────────────────────────
function hashPassword(password, salt) {
  return createHash('sha256').update(salt + password + PASSWORD_PEPPER).digest('hex');
}
async function hashPw(password) {
  if (bcrypt) return { hash: await bcrypt.hash(password, 12), salt: null };
  const salt = randomUUID().replace(/-/g, '');
  return { hash: hashPassword(password, salt), salt };
}
async function verifyPw(password, user) {
  const h = user.hash || '';
  if (h.startsWith('$2b$') || h.startsWith('$2a$')) {
    return bcrypt ? bcrypt.compare(password, h) : false;
  }
  return h === hashPassword(password, user.salt || '');
}

// Cache validated sessions for 60 s — avoids 2 Supabase round-trips on every request.
const _sessionCache = new Map(); // token → { user, exp }
function _invalidateSession(token) { _sessionCache.delete(token); }
function _invalidateUserSessions(userId) {
  for (const [t, e] of _sessionCache) { if (e.user?.id === userId) _sessionCache.delete(t); }
}
setInterval(() => { const now = Date.now(); for (const [t, e] of _sessionCache) if (now > e.exp) _sessionCache.delete(t); }, 120000);

async function userBlockedReason(user) {
  const columnReason = String(user?.blocked_reason || '').trim();
  if (columnReason) return columnReason;
  return user?.id ? String(await getUserBlockReason(user.id) || '').trim() : '';
}

async function userBlockedMessage(user) {
  const reason = await userBlockedReason(user);
  return reason
    ? `Your account has been suspended. Reason: ${reason}`
    : 'Your account has been suspended. Contact support.';
}

async function blockedUserResponse(res, user) {
  const reason = await userBlockedReason(user);
  return json(res, { error: reason ? `Your account has been suspended. Reason: ${reason}` : await userBlockedMessage(user), blocked: true, blockedReason: reason }, 403);
}

async function getSessionUser(req) {
  const cookieToken = String(req.headers.cookie || '')
    .split(';')
    .map(part => part.trim())
    .find(part => part.startsWith('wc_auth_token='))
    ?.slice('wc_auth_token='.length);
  let token = req.headers['x-auth-token'] || (cookieToken ? decodeURIComponent(cookieToken) : '');
  // Allow iframe/preview URLs to authenticate via query (cross-origin Frontend → Backend).
  if (!token && req.url) {
    try {
      const q = new URL(req.url, 'http://localhost').searchParams;
      token = q.get('access_token') || q.get('authToken') || '';
    } catch {}
  }
  if (!token) return null;
  const hit = _sessionCache.get(token);
  if (hit) {
    if (Date.now() > hit.exp) { _sessionCache.delete(token); } else return hit.user;
  }
  const session = await getSession(token);
  if (!session) return null;
  if (Date.now() > session.expires_at) { await deleteSession(token); return null; }
  const user = await getUserById(session.user_id);
  if (!user) return null;
  user._sessionToken = token;
  user._impersonatedBy = session.impersonated_by || null;
  _sessionCache.set(token, { user, exp: Date.now() + 60000 });
  return user;
}

// ── Settings cache ────────────────────────────────────────────────────────────
const SETTINGS_DEFAULTS = {
  btc:'', eth:'', usdt_trc20:'', paypal_email:'', paypal_me:'', app_note:'',
  smtp_host:'', smtp_port:'587', smtp_user:'', smtp_pass:'', smtp_from:'',
  smtp_secure: false, app_url: DEFAULT_APP_URL, support_email:'',
  affiliate_enabled:'true', affiliate_program_url:'https://affonso.io/', affiliate_public_id:DEFAULT_AFFONSO_PUBLIC_ID,
  affiliate_program_id:'', affiliate_group_id:'', affiliate_api_key:'',
};
let _settingsCache = { ...SETTINGS_DEFAULTS };
async function initSettings() { _settingsCache = await getSettings(); }
const getCachedSettings = () => _settingsCache;
const invalidateSettingsCache = async () => {
  _settingsCache = await getSettings();
  _emailTemplateCache.clear(); // templates may reference APP_URL / SUPPORT_EMAIL from settings
};

function normalizeAffiliateUrl(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  let parsed;
  try {
    parsed = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
  } catch {
    return null;
  }
  if (!['http:', 'https:'].includes(parsed.protocol)) return null;
  return parsed.toString();
}

function cleanAffiliatePublicId(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  return /^[A-Za-z0-9_-]{3,180}$/.test(raw) ? raw : null;
}

function splitAffiliateName(nameOrEmail = '') {
  const raw = String(nameOrEmail || '').trim();
  const fallback = raw.includes('@') ? raw.split('@')[0] : raw;
  const parts = (fallback || 'CLONYFY Partner').split(/\s+/).filter(Boolean);
  return {
    firstName: parts[0] || 'CLONYFY',
    lastName: parts.slice(1).join(' ') || 'Partner',
  };
}

function affiliateSlug(user) {
  const raw = `${user.name || user.email || user.id || 'partner'}-${user.id || ''}`.toLowerCase();
  const slug = raw.replace(/@.*/, '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
  return slug || `partner-${String(user.id || '').slice(0, 8) || 'clonyfy'}`;
}

function localReferralLink(req, user) {
  const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host || '';
  const isLocal = /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(String(host));
  const base = isLocal ? `http://${host}` : publicAppUrl(req);
  return `${String(base).replace(/\/$/, '')}/?via=${encodeURIComponent(affiliateSlug(user))}`;
}

function cleanReferralCode(value) {
  return String(value || '').trim().toLowerCase().replace(/[^a-z0-9_-]/g, '').slice(0, 80);
}

async function createAffonsoEmbedToken(user, settings) {
  const names = splitAffiliateName(user.name || user.email);
  const payload = {
    programId: settings.affiliate_program_id,
    partner: {
      email: user.email,
      name: user.name || `${names.firstName} ${names.lastName}`.trim(),
    },
  };
  if (settings.affiliate_group_id) payload.groupId = settings.affiliate_group_id;
  const affonsoRes = await fetch('https://api.affonso.io/v1/embed/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${settings.affiliate_api_key}`,
    },
    body: JSON.stringify(payload),
  });
  const data = await affonsoRes.json().catch(() => ({}));
  if (!affonsoRes.ok) {
    throw new Error(data?.message || data?.error || 'Affonso could not create an embed token.');
  }
  const root = data.data || data;
  return {
    token: root.token || root.embedToken || root.publicToken || data.token || data.publicToken || '',
    link: root.link || root.referralLink || root.referral_link || data.link || '',
    partner: root.partner || data.partner || null,
  };
}

async function getAffonsoEmbedData(token) {
  const affonsoRes = await fetch(`https://api.affonso.io/v1/embed/data?token=${encodeURIComponent(token)}`);
  const data = await affonsoRes.json().catch(() => ({}));
  if (!affonsoRes.ok) {
    throw new Error(data?.message || data?.error || 'Affonso dashboard data could not be loaded.');
  }
  return data.data || data;
}

function publicAppUrl(req = null) {
  // Explicit share-host override (optional). Prefer this only when set on purpose.
  const shareBase = String(process.env.SHARE_BASE_URL || '').replace(/\/$/, '');
  if (shareBase) return shareBase;

  const host = req?.headers?.['x-forwarded-host'] || req?.headers?.host;
  const firstHost = host ? String(host).split(',')[0].trim() : '';
  const isLocalHost = (value) => /^(localhost|127\.0\.0\.1)(:\d+)?$/i.test(value);

  // Prefer the request host so share links match the deployment the user is on
  // (e.g. a Render onrender.com URL), not a hardcoded production domain.
  if (req && firstHost) {
    const defaultProto = isLocalHost(firstHost) ? 'http' : 'https';
    const proto = String(req.headers['x-forwarded-proto'] || defaultProto).split(',')[0].trim() || defaultProto;
    return `${proto}://${firstHost}`.replace(/\/$/, '');
  }

  // Fallbacks when there is no request (emails, background jobs).
  const configured = String(getCachedSettings().app_url || '').replace(/\/$/, '');
  const isLocalUrl = (value) => /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(value);
  if (CANONICAL_APP_URL) return CANONICAL_APP_URL;
  if (configured && !isLocalUrl(configured)) return configured;
  if (process.env.APP_URL) return process.env.APP_URL.replace(/\/$/, '');
  if (RENDER_EXTERNAL_URL) return RENDER_EXTERNAL_URL;
  return configured || DEFAULT_APP_URL;
}

/** Browser UI origin (separate Frontend app). Falls back to publicAppUrl. */
function frontendPublicUrl(req = null) {
  const fe = String(process.env.FRONTEND_URL || process.env.PUBLIC_APP_URL || '').replace(/\/$/, '');
  if (fe) return fe;
  return publicAppUrl(req);
}

/** This Backend's public origin (OAuth callback must hit the API host). */
function apiPublicUrl(req = null) {
  if (RENDER_EXTERNAL_URL) return RENDER_EXTERNAL_URL;
  if (process.env.APP_URL) return String(process.env.APP_URL).replace(/\/$/, '');
  return publicAppUrl(req);
}

// ── Email templates ───────────────────────────────────────────────────────────
const _emailTemplateCache = new Map();
function renderEmail(templateName, vars) {
  const s = getCachedSettings();
  const appUrl = (s.app_url || `http://localhost:${PORT}`).replace(/\/$/, '');
  const host = (() => { try { return new URL(appUrl).host; } catch { return appUrl; } })();
  const base = {
    APP_URL: appUrl,
    APP_HOST: host,
    SUPPORT_EMAIL: s.support_email || s.smtp_from || `support@${host}`,
    YEAR: new Date().getFullYear(),
    SUBJECT: vars.SUBJECT || 'CLONYFY',
    ...vars,
  };

  const contentPath = join(EMAILS_DIR, `${templateName}.html`);
  const basePath = join(EMAILS_DIR, '_base.html');

  let content = _emailTemplateCache.get(contentPath);
  if (!content) {
    try { content = readFileSync(contentPath, 'utf8'); } catch { content = `<p>{{SUBJECT}}</p>`; }
    _emailTemplateCache.set(contentPath, content);
  }
  let baseHtml = _emailTemplateCache.get(basePath);
  if (!baseHtml) {
    try { baseHtml = readFileSync(basePath, 'utf8'); } catch { baseHtml = '{{CONTENT}}'; }
    _emailTemplateCache.set(basePath, baseHtml);
  }

  const fill = (tpl, data) => tpl.replace(/\{\{([A-Z0-9_]+)\}\}/g, (_, k) =>
    data[k] !== undefined ? htmlEsc(String(data[k])) : '');

  const filledContent = fill(content, base);
  return fill(baseHtml.replace('{{CONTENT}}', filledContent), base);
}

// ── Stripe ────────────────────────────────────────────────────────────────────
let _stripeInstance = null, _stripeKey = '';
function getStripe() {
  const s = getStripeSettings();
  const key = s.stripe_secret_key || '';
  if (!key || !StripeLib) return null;
  if (_stripeInstance && _stripeKey === key) return _stripeInstance;
  const Ctor = StripeLib.default || StripeLib;
  _stripeInstance = new Ctor(key, { apiVersion: '2024-06-20' });
  _stripeKey = key;
  return _stripeInstance;
}
function stripeUnavailableReason() {
  const s = getStripeSettings();
  if (!StripeLib) return 'Stripe package is not installed on the server.';
  if (!s.stripe_secret_key) return 'Missing STRIPE_SECRET_KEY environment variable or admin Stripe Secret Key.';
  return '';
}

// Map of plan+interval → settings key for Stripe price IDs
const STRIPE_PRICE_KEY = (plan, interval) => `stripe_price_${plan}_${interval}`;
const STRIPE_PRICE_ENV_KEY = (plan, interval) => `STRIPE_PRICE_${plan}_${interval}`.toUpperCase();
const SECRET_MASK = '••••••••';
function isMaskedSecret(value) {
  const v = String(value || '').trim();
  return v === SECRET_MASK || /^â€¢+$/.test(v);
}
function cleanSettingValue(value) {
  if (value === undefined || value === null || isMaskedSecret(value)) return '';
  return String(value).trim();
}
function validateStripeSetting(key, value) {
  if (!value) return '';
  if (key === 'stripe_secret_key' && !/^sk_(test|live)_[A-Za-z0-9_]+$/.test(value)) {
    return 'Stripe Secret Key must start with sk_test_ or sk_live_.';
  }
  if (key === 'stripe_publishable_key' && !/^pk_(test|live)_[A-Za-z0-9_]+$/.test(value)) {
    return 'Stripe Publishable Key must start with pk_test_ or pk_live_.';
  }
  if (key === 'stripe_webhook_secret' && !/^whsec_[A-Za-z0-9_]+$/.test(value)) {
    return 'Stripe Webhook Secret must start with whsec_.';
  }
  if (key.startsWith('stripe_price_') && !/^price_[A-Za-z0-9_]+$/.test(value)) {
    return `${key} must be a Stripe price id that starts with price_.`;
  }
  return '';
}
function envFirst(...keys) {
  for (const key of keys) {
    const value = process.env[key];
    if (value) return String(value).trim();
  }
  return '';
}

// ── Cloudflare Turnstile (CAPTCHA) ───────────────────────────────────────────
// Enabled when TURNSTILE_SECRET_KEY is set in env. Sitekey is also read from
// env and exposed via /api/auth/captcha-config so the client can render the
// widget. When unconfigured, auth endpoints skip verification (back-compat).
function turnstileSiteKey() { return envFirst('TURNSTILE_SITE_KEY', 'NEXT_PUBLIC_TURNSTILE_SITE_KEY'); }
function turnstileSecretKey() { return envFirst('TURNSTILE_SECRET_KEY'); }
function turnstileEnabled() { return !!(turnstileSiteKey() && turnstileSecretKey()); }
async function verifyTurnstile(token, remoteIp) {
  // Returns true if verification passes or CAPTCHA isn't configured.
  if (!turnstileEnabled()) return true;
  if (!token || typeof token !== 'string') return false;
  try {
    const body = new URLSearchParams();
    body.set('secret', turnstileSecretKey());
    body.set('response', token);
    if (remoteIp) body.set('remoteip', String(remoteIp));
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 8000);
    try {
      const res = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
        method: 'POST', body, signal: ctl.signal,
      });
      const data = await res.json().catch(() => ({}));
      return !!data?.success;
    } finally { clearTimeout(timer); }
  } catch { return false; }
}
function getStripeSettings(raw = getCachedSettings()) {
  const out = { ...raw };
  out.stripe_secret_key = cleanSettingValue(raw.stripe_secret_key) || envFirst('STRIPE_SECRET_KEY', 'STRIPE_SECRET', 'STRIPE_SK', 'STRIPE_PRIVATE_KEY');
  out.stripe_webhook_secret = cleanSettingValue(raw.stripe_webhook_secret) || envFirst('STRIPE_WEBHOOK_SECRET');
  out.stripe_publishable_key = cleanSettingValue(raw.stripe_publishable_key) || envFirst('STRIPE_PUBLISHABLE_KEY', 'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY', 'STRIPE_PK');
  for (const plan of PAID_PLAN_KEYS) {
    for (const interval of ['monthly', 'annual']) {
      const key = STRIPE_PRICE_KEY(plan, interval);
      const legacyKeys = legacyAliasesForPlan(plan).map(alias => STRIPE_PRICE_KEY(alias, interval));
      const legacyEnvKeys = legacyAliasesForPlan(plan).map(alias => STRIPE_PRICE_ENV_KEY(alias, interval));
      out[key] = cleanSettingValue(raw[key])
        || envFirst(STRIPE_PRICE_ENV_KEY(plan, interval))
        || legacyKeys.map(k => cleanSettingValue(raw[k])).find(Boolean)
        || envFirst(...legacyEnvKeys);
      for (const legacyKey of legacyKeys) out[legacyKey] = cleanSettingValue(raw[legacyKey]) || out[key];
    }
  }
  return out;
}
function stripePeriodEnd(sub) {
  return sub?.current_period_end || sub?.items?.data?.[0]?.current_period_end || null;
}
async function ensureStripePrice(stripe, plan, interval) {
  plan = normalizePlan(plan);
  const s = getStripeSettings();
  const key = STRIPE_PRICE_KEY(plan, interval);
  if (s[key]) return s[key];

  const amount = getPlanPrices(plan)?.[interval];
  if (!amount) throw new Error(`No local price exists for ${plan} ${interval}.`);

  // Search Stripe for an existing active price matching this plan+interval
  // before creating a new one — prevents duplicate products on settings loss.
  const existing = await stripe.prices.search({
    query: `metadata['app']:'clonyfy' AND metadata['plan']:'${plan}' AND metadata['billing_interval']:'${interval}' AND active:'true'`,
    limit: 1,
  }).catch(() => ({ data: [] }));

  let priceId = existing.data[0]?.id || '';

  if (!priceId) {
    const product = await stripe.products.create({
      name: `CLONYFY ${getPlanLabel(plan)}`,
      metadata: { app: 'clonyfy', plan },
    });
    const price = await stripe.prices.create({
      currency: 'usd',
      unit_amount: Math.round(amount * 100),
      recurring: { interval: interval === 'annual' ? 'year' : 'month' },
      product: product.id,
      metadata: { app: 'clonyfy', plan, billing_interval: interval },
    });
    priceId = price.id;
  }

  try {
    const current = { ...getCachedSettings(), [key]: priceId };
    await saveSettings(current);
    await invalidateSettingsCache();
  } catch (err) {
    console.warn('[Stripe] could not save price ID to settings:', err.message);
  }
  return priceId;
}

// ── Google OAuth state ────────────────────────────────────────────────────────
const _oauthStates = new Map(); // state → expiresAt
setInterval(() => { const now = Date.now(); for (const [k, v] of _oauthStates) if (now > v) _oauthStates.delete(k); }, 300000);

// ── Email ─────────────────────────────────────────────────────────────────────
let _mailerTransport = null;
let _mailerKey = '';
async function sendEmail(to, subject, html) {
  const s = getCachedSettings();
  if (!s.smtp_host || !nodemailer) {
    console.log(`\n[Email → ${to}]\nSubject: ${subject}\n${html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()}\n`);
    return;
  }
  const key = `${s.smtp_host}:${s.smtp_port}:${s.smtp_user}:${s.smtp_pass}:${s.smtp_secure}`;
  if (!_mailerTransport || key !== _mailerKey) {
    _mailerTransport = nodemailer.createTransport({
      host: s.smtp_host,
      port: parseInt(s.smtp_port, 10) || 587,
      secure: s.smtp_secure === true || s.smtp_secure === '1' || s.smtp_secure === 'true' || s.smtp_port === '465',
      auth: s.smtp_user ? { user: s.smtp_user, pass: s.smtp_pass } : undefined,
    });
    _mailerKey = key;
  }
  try {
    await _mailerTransport.sendMail({ from: s.smtp_from || s.smtp_user || 'noreply@clonyfy.app', to, subject, html });
  } catch(err) {
    console.error('[Email error]', err.message);
    _mailerTransport = null; // force recreate on next send
  }
}

// ── Dunning / subscription expiry ─────────────────────────────────────────────
async function runDunning() {
  try {
    const users = await getAllUsers();
    const now = Date.now();
    const s = getCachedSettings();
    const appUrl = s.app_url || `http://localhost:${PORT}`;
    for (const u of users) {
      if (!u.plan_renews_at || u.plan === 'free') continue;
      const renewsAt = new Date(u.plan_renews_at).getTime();
      if (now < renewsAt) continue;
      const graceEnd = renewsAt + 7 * 24 * 3600 * 1000;
      if (!u.renewal_reminder_sent) {
        await updateUser(u.id, { renewal_reminder_sent: 1 });
        sendEmail(u.email, 'Your CLONYFY subscription has expired',
          renderEmail('renewal-reminder', { SUBJECT: 'Your subscription has expired', NAME: u.name, PLAN: u.plan, EXPIRED_AT: new Date(renewsAt).toLocaleDateString() })
        ).catch(() => {});
      }
      if (u.cancel_at_period_end || now > graceEnd) {
        await updateUser(u.id, { plan: 'free', plan_renews_at: null, cancel_at_period_end: 0, renewal_reminder_sent: 0, usage_alert_sent: 0 });
        sendEmail(u.email, 'Your account has been downgraded to Free',
          renderEmail('downgraded', { SUBJECT: 'Account downgraded to Free', NAME: u.name })
        ).catch(() => {});
      }
    }
  } catch(err) {
    console.error('[Dunning error]', err.message);
  }
}

// ── Usage alerts ──────────────────────────────────────────────────────────────
async function checkUsageAlert(userId) {
  try {
    const user = await getUserById(userId);
    if (!user || !isPaidPlan(user.plan) || user.usage_alert_sent) return;
    const plan = normalizePlan(user.plan);
    const limits = getEffectivePlanLimits(plan);
    if (limits.clonesPerMonth === Infinity) return;
    const used = await getCloneCountThisMonth(userId, planPeriodStart(user).toISOString());
    const pct = used / limits.clonesPerMonth;
    if (pct >= 0.8) {
      await updateUser(userId, { usage_alert_sent: 1 });
      const s = getCachedSettings();
      const appUrl = s.app_url || `http://localhost:${PORT}`;
      sendEmail(user.email, "You've used 80% of your monthly clone quota",
        renderEmail('usage-alert', { SUBJECT: "You've used 80% of your quota", NAME: user.name, USED: String(used), LIMIT: String(limits.clonesPerMonth), PCT: String(Math.round(pct * 100)) })
      ).catch(() => {});
    }
  } catch {}
}

// ── Helpers ───────────────────────────────────────────────────────────────────
const OUTPUT_DIR = resolve(process.env.CLONYFY_OUTPUT_DIR || './output');

function ensureOutputDir() {
  mkdirSync(OUTPUT_DIR, { recursive: true });
}

// Ephemeral disks fill up with old clones. Before each new clone we wipe every
// clone directory except the ones in `keepDirs` (active jobs). Safe locally —
// no-op when there's nothing old.
function cleanupTmpClones(keepDirs = []) {
  try {
    if (!existsSync(OUTPUT_DIR)) return;
    const keepSet = new Set(keepDirs.map(d => String(d).replace(/[\\/]+$/, '')));
    const entries = readdirSync(OUTPUT_DIR, { withFileTypes: true });
    let freed = 0;
    for (const ent of entries) {
      if (!ent.isDirectory()) continue;
      const full = join(OUTPUT_DIR, ent.name);
      if (keepSet.has(full)) continue;
      try {
        // Best-effort cumulative size (capped) for logging
        rmSync(full, { recursive: true, force: true });
        freed++;
      } catch {}
    }
    if (freed > 0) console.log(`[tmp cleanup] removed ${freed} old clone dir(s) from ${OUTPUT_DIR}`);
  } catch (err) {
    console.warn('[tmp cleanup] failed:', err?.message || err);
  }
}

function cleanupServerlessTemp(keepDirs = []) {
  cleanupTmpClones(keepDirs);
  if (!IS_SERVERLESS) return;
  try {
    const tmp = tmpdir();
    for (const ent of readdirSync(tmp, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const name = ent.name;
      if (!/^(playwright|chromium|puppeteer|chrome|clonyfy-figma)/i.test(name)) continue;
      try {
        rmSync(join(tmp, name), { recursive: true, force: true });
      } catch {}
    }
  } catch (err) {
    console.warn('[tmp cleanup] serverless temp failed:', err?.message || err);
  }
}

async function offloadCloneArtifact(outDir, event) {
  if (!event?.absPath || !existsSync(event.absPath)) return;
  const relPath = String(event.relPath || '').replace(/\\/g, '/');
  if (!relPath) return;
  const data = readFileSync(event.absPath);
  const storagePath = cloneStoragePath(outDir, relPath);
  await uploadCloneFileWithRetry(storagePath, data, contentTypeForPath(relPath));
  if (event.kind === 'page' || event.kind === 'asset') {
    try { rmSync(event.absPath, { force: true }); } catch {}
  }
}

async function uploadCloneFileWithRetry(storagePath, data, contentType, attempts = 4) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    try {
      await uploadCloneFile(storagePath, data, contentType);
      return;
    } catch (err) {
      lastErr = err;
      if (i + 1 < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 250 * (i + 1)));
      }
    }
  }
  throw lastErr;
}

function createCloneOffloadQueue(outDir, onWarn) {
  const pending = new Set();
  let serial = Promise.resolve();

  function offload(event) {
    const task = serial.then(async () => {
      await offloadCloneArtifact(outDir, event);
    }).catch((err) => {
      const critical = event?.kind === 'page' || event?.kind === 'route-map' || event?.kind === 'manifest';
      if (critical) throw err;
      onWarn?.(`Could not offload ${event?.relPath}: ${err?.message || err}`);
    });
    serial = task.catch(() => {});
    pending.add(task);
    task.finally(() => pending.delete(task));
    return task;
  }

  return {
    offload,
    flush: async () => {
      const results = await Promise.allSettled([...pending]);
      const hardFail = results.find((r) => r.status === 'rejected');
      if (hardFail) throw hardFail.reason;
    },
  };
}

async function verifyCloneReadableWithRetry(outDir, attempts = 5) {
  let last = { ok: false, error: 'Unknown error' };
  for (let i = 0; i < attempts; i++) {
    last = await verifyCloneReadable(outDir);
    if (last.ok) return last;
    if (i + 1 < attempts) {
      await new Promise((resolve) => setTimeout(resolve, 400 * (i + 1)));
    }
  }
  return last;
}

/** Best-effort page count from disk or persisted storage (route-map / captured-pages). */
async function countClonePagesBestEffort(outDir) {
  try {
    const readable = await verifyCloneReadable(outDir);
    if (readable?.ok && readable.pages > 0) return readable.pages;
  } catch {}
  try {
    const pagesDir = join(outDir, 'captured-pages');
    if (existsSync(pagesDir)) {
      const n = readdirSync(pagesDir).filter(
        (f) => f.endsWith('.html') && f !== '__login__.html' && f !== '__register__.html',
      ).length;
      if (n > 0) return n;
    }
  } catch {}
  try {
    const map = (await loadRouteMapAsync(outDir)) || (await inferRouteMapFromCapturedPages(outDir));
    if (map && Object.keys(map).length) return Object.keys(map).length;
  } catch {}
  return 0;
}

const _fileCache = new Map();
function affonsoPixelHtml() {
  const s = getCachedSettings();
  const enabled = s.affiliate_enabled === true || s.affiliate_enabled === 'true';
  const publicId = String(s.affiliate_public_id || DEFAULT_AFFONSO_PUBLIC_ID).trim();
  if (!enabled || !publicId) return '';
  return `<script async defer src="https://cdn.affonso.io/js/pixel.min.js" data-affonso="${htmlEsc(publicId)}" data-cookie_duration="30"></script>`;
}

function injectAffonsoPixel(html) {
  if (!html || /<script\b[^>]*src=["']https:\/\/cdn\.affonso\.io\/js\/pixel\.min\.js["'][^>]*>/i.test(html)) return html;
  const script = affonsoPixelHtml();
  if (!script) return html;
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${script}\n</head>`);
  return `${script}\n${html}`;
}

/** Inject public frontend config (e.g. Community plugin URL after Figma publish). */
function injectPublicRuntimeConfig(html) {
  if (!html) return html;
  const figmaPluginUrl = String(process.env.FIGMA_COMMUNITY_PLUGIN_URL || '').trim();
  const script = `<script>window.__CLONYFY_FIGMA_PLUGIN_URL__=${JSON.stringify(figmaPluginUrl)};</script>`;
  if (/window\.__CLONYFY_FIGMA_PLUGIN_URL__\s*=/.test(html)) {
    return html.replace(
      /<script>\s*window\.__CLONYFY_FIGMA_PLUGIN_URL__\s*=\s*[^;]*;\s*<\/script>/i,
      script,
    );
  }
  if (/<\/head>/i.test(html)) return html.replace(/<\/head>/i, `${script}\n</head>`);
  return `${script}\n${html}`;
}

function serveFile(res, filePath, contentType, cacheSecs = 0) {
  try {
    let data = _fileCache.get(filePath);
    if (!data) {
      data = readFileSync(filePath);
      if (cacheSecs > 0) _fileCache.set(filePath, data);
    }
    if (String(contentType || '').toLowerCase().includes('text/html')) {
      let html = data.toString('utf8');
      html = injectAffonsoPixel(html);
      html = injectPublicRuntimeConfig(html);
      data = Buffer.from(html, 'utf8');
    }
    const headers = { 'Content-Type': contentType };
    if (String(contentType || '').toLowerCase().includes('text/html')) {
      headers['Cache-Control'] = 'no-store, no-cache, must-revalidate, max-age=0';
    }
    if (cacheSecs > 0) headers['Cache-Control'] = `public, max-age=${cacheSecs}`;
    res.writeHead(200, headers);
    res.end(data);
  } catch {
    res.writeHead(404);
    res.end('Not found');
  }
}

function json(res, data, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(data));
}

/** Return a Figma scene inline, or via signed/chunked Storage when too large for a direct response. */
async function respondWithFigmaScene(res, scene, user) {
  const slimmed = slimFigmaSceneForTransport(scene);
  if (!Array.isArray(slimmed.nodes) || !slimmed.nodes.length) {
    return json(res, { error: 'Empty scene — this page has no exportable layers. Re-clone or open a page with visible content.' }, 422);
  }
  const payload = JSON.stringify({ ok: true, scene: slimmed });
  const SAFE = 3 * 1024 * 1024;
  if (payload.length <= SAFE) {
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Cache-Control': 'no-store',
      'Content-Length': Buffer.byteLength(payload),
    });
    res.end(payload);
    return;
  }

  const tmpPath = join(tmpdir(), `clonyfy-figma-scene-${randomUUID()}.json`);
  writeFileSync(tmpPath, payload);
  try {
    const delivered = await uploadExportZipForDownload(
      `figma-scenes/${user.id}/${randomUUID().slice(0, 8)}`,
      tmpPath,
      'scene.json',
    );
    return json(res, { ok: true, kind: 'figma-scene-ref', sceneMeta: { nodes: slimmed.nodes.length, name: slimmed.name }, ...delivered });
  } catch (err) {
    if (isStorageSizeLimitError(err)) {
      // Last resort: strip all embedded bitmaps and return a tiny layout scene.
      const tiny = slimFigmaSceneForTransport(slimmed, 500_000);
      const walk = (nodes) => {
        for (const node of nodes || []) {
          if (node.type === 'IMAGE') {
            node.type = 'RECT';
            node.fill = '#c4c4c4';
            delete node.src;
            delete node.objectFit;
          }
          if (Array.isArray(node.children)) walk(node.children);
        }
      };
      walk(tiny.nodes);
      return json(res, { ok: true, scene: tiny, warning: 'Large images were replaced with placeholders so Figma export could complete.' });
    }
    throw err;
  } finally {
    try { rmSync(tmpPath, { force: true }); } catch {}
  }
}

function isInsideOutputDir(candidate) {
  return isInsideDir(OUTPUT_DIR, candidate);
}

function isInsideDir(baseDir, candidate) {
  const base = resolve(baseDir);
  const resolved = resolve(candidate || '');
  return resolved === base || resolved.startsWith(base + '\\') || resolved.startsWith(base + '/');
}

/** Stable folder name for a clone output path (works across hosts / redeploys). */
function outDirBasename(outDir) {
  const parts = String(outDir || '').replace(/\\/g, '/').split('/').filter(Boolean);
  return parts[parts.length - 1] || '';
}

/**
 * Normalize client/DB outDir to an absolute path under OUTPUT_DIR.
 * Accepts absolute paths, relative paths, or bare folder names so preview/ZIP
 * keep working after Render redeploys change the absolute prefix.
 */
function resolveCloneOutDir(candidate) {
  const raw = String(candidate || '').trim();
  if (!raw) return '';
  if (isInsideOutputDir(raw)) return resolve(raw);
  const base = outDirBasename(raw);
  if (!base || base === '..' || base.includes('..')) return '';
  // Clone folders look like www-shopify-com-a1b2c3 or builder-…
  if (!/^[A-Za-z0-9._-]+$/.test(base)) return '';
  const mapped = resolve(OUTPUT_DIR, base);
  return isInsideOutputDir(mapped) ? mapped : '';
}

function sameCloneOutDir(a, b) {
  if (!a || !b) return false;
  if (a === b) return true;
  const ba = outDirBasename(a);
  const bb = outDirBasename(b);
  return !!ba && ba === bb;
}

function normalizeCloneRelPath(input, allowedPrefixes = []) {
  const normalized = String(input || '')
    .replace(/\\/g, '/')
    .replace(/^\/+/, '')
    .replace(/\/+/g, '/')
    .replace(/\/+$/g, '');
  if (!normalized || normalized.length > 500) throw new Error('Invalid clone file path');
  if (/[\x00-\x1F]/.test(normalized)) throw new Error('Invalid clone file path');
  const parts = normalized.split('/');
  if (parts.some(part => !part || part === '.' || part === '..')) throw new Error('Invalid clone file path');
  if (allowedPrefixes.length && !allowedPrefixes.some(prefix => normalized === prefix || normalized.startsWith(prefix + '/'))) {
    throw new Error('Invalid clone file path');
  }
  return normalized;
}

function posixCloneRel(...parts) {
  const joined = parts
    .map((part) => String(part ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').replace(/[\x00-\x1F]/g, ''))
    .filter(Boolean)
    .join('/');
  return normalizeCloneRelPath(joined);
}

function capturedPageStorageRel(filename) {
  let name = String(filename || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/[\x00-\x1F]/g, '').trim();
  if (name.startsWith('captured-pages/')) name = name.slice('captured-pages/'.length);
  if (!name) throw new Error('Page file missing');
  return posixCloneRel('captured-pages', name);
}

function assetStorageRel(input) {
  let rel = String(input || '').replace(/\\/g, '/').replace(/^\/+/, '').replace(/[\x00-\x1F]/g, '').trim();
  if (rel.startsWith('public/')) rel = rel.slice('public/'.length);
  const parts = rel.split('/').filter((part) => part && part !== '.' && part !== '..');
  if (!parts.length || parts[0] !== '_assets' || parts.length < 2) return null;
  return posixCloneRel('public', ...parts);
}

/** Preferred storage key: basename only (stable across absolute path changes). */
function cloneStoragePrefix(outDir) {
  const base = outDirBasename(outDir) || String(outDir || '');
  return createHash('sha1').update(base).digest('hex').slice(0, 24);
}

/** Legacy key used before basename-stable prefixes (full absolute outDir). */
function legacyCloneStoragePrefix(outDir) {
  return createHash('sha1').update(String(outDir || '')).digest('hex').slice(0, 24);
}

function cloneStoragePrefixes(outDir) {
  const preferred = cloneStoragePrefix(outDir);
  const legacy = legacyCloneStoragePrefix(outDir);
  return preferred === legacy ? [preferred] : [preferred, legacy];
}

function cloneStoragePath(outDir, relPath) {
  return `${cloneStoragePrefix(outDir)}/${normalizeCloneRelPath(relPath)}`;
}

function cloneStoragePathCandidates(outDir, relPath) {
  const rel = normalizeCloneRelPath(relPath);
  return cloneStoragePrefixes(outDir).map((prefix) => `${prefix}/${rel}`);
}

function cloneFileListStoragePath(outDir) {
  return cloneStoragePath(outDir, '__files.json');
}

function cloneAssetToken(outDir) {
  const key = outDirBasename(outDir) || String(outDir || '');
  return createHash('sha256').update(`${key}:${PASSWORD_PEPPER}`).digest('hex').slice(0, 32);
}

function cloneAssetTokenMatches(outDir, token) {
  if (!token) return false;
  if (token === cloneAssetToken(outDir)) return true;
  // Legacy tokens hashed the full absolute path.
  const legacy = createHash('sha256').update(`${String(outDir || '')}:${PASSWORD_PEPPER}`).digest('hex').slice(0, 32);
  return token === legacy;
}

function contentTypeForPath(filePath) {
  const ext = filePath.match(/\.\w+$/)?.[0]?.toLowerCase();
  return {
    '.html': 'text/html; charset=utf-8',
    '.json': 'application/json',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.svg': 'image/svg+xml',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.webp': 'image/webp',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
    '.eot': 'application/vnd.ms-fontobject',
    '.mp4': 'video/mp4',
    '.webm': 'video/webm',
    '.avif': 'image/avif',
  }[ext] || 'application/octet-stream';
}

async function persistCloneOutput(outDir, options = {}) {
  const deferAssets = !!options.deferAssets;
  const assetsOnly = !!options.assetsOnly;
  const requireCritical = options.requireCritical !== false;
  if (!isInsideOutputDir(outDir) || !existsSync(outDir)) {
    if (requireCritical && !assetsOnly) throw new Error('Output folder missing on disk — cannot persist clone');
    return { uploaded: 0, total: 0 };
  }
  const files = [];
  const addFile = (rel) => {
    const abs = join(outDir, rel);
    if (existsSync(abs) && statSync(abs).isFile()) files.push({ rel: rel.replace(/\\/g, '/'), abs });
  };
  addFile('route-map.json');
  addFile('manifest.json');
  const walk = (baseRel) => {
    const baseAbs = join(outDir, baseRel);
    if (!existsSync(baseAbs)) return;
    for (const entry of readdirSync(baseAbs, { withFileTypes: true })) {
      const rel = join(baseRel, entry.name);
      const abs = join(outDir, rel);
      if (entry.isDirectory()) walk(rel);
      else if (entry.isFile()) files.push({ rel: rel.replace(/\\/g, '/'), abs });
    }
  };
  walk('captured-pages');
  walk(join('public', '_assets'));

  let uploaded = 0;
  let skipped = 0;
  let fallbackSaved = 0;
  const failures = [];
  // Hosted Storage uploads time out on huge binaries — preview only needs HTML + modest assets.
  // Supabase Free global object cap is ~50MB; stay under that for every object.
  const maxAssetUploadBytes = IS_HOSTED ? 8 * 1024 * 1024 : 50 * 1024 * 1024;
  const maxObjectBytes = IS_HOSTED ? 45 * 1024 * 1024 : 50 * 1024 * 1024;

  const slimManifestBuffer = (buf) => {
    try {
      const parsed = JSON.parse(buf.toString('utf8'));
      const pages = Array.isArray(parsed?.pages) ? parsed.pages.map((page) => ({
        url: page?.url || '',
        route: page?.route || '',
        html: '',
        assets: Array.isArray(page?.assets)
          ? page.assets.map((a) => ({
            originalUrl: a?.originalUrl || a?.url || '',
            localPath: a?.localPath || a?.path || '',
            contentType: a?.contentType || '',
          })).filter((a) => a.originalUrl || a.localPath)
          : [],
        network: [],
        failedAssets: Array.isArray(page?.failedAssets) ? page.failedAssets.slice(0, 50) : [],
      })) : [];
      return Buffer.from(JSON.stringify({
        targetOrigin: parsed?.targetOrigin || '',
        capturedAt: parsed?.capturedAt || new Date().toISOString(),
        pages,
      }), 'utf8');
    } catch {
      return null;
    }
  };

  const uploadOne = async (file) => {
    const size = statSync(file.abs).size;
    const isPage = file.rel.startsWith('captured-pages/');
    const isRouteMap = file.rel === 'route-map.json';
    const isManifest = file.rel === 'manifest.json';
    // Pages + route-map are required for preview. Manifest is helpful but optional.
    const isRequiredCritical = isRouteMap || isPage;
    const isCritical = isRequiredCritical || isManifest;
    if (size > maxAssetUploadBytes && !isCritical) {
      skipped++;
      return;
    }
    if (size > maxObjectBytes && !isManifest && !isRequiredCritical) {
      skipped++;
      return;
    }
    const storagePath = cloneStoragePath(outDir, file.rel);
    let data = readFileSync(file.abs);
    if (isManifest && data.length > maxObjectBytes) {
      const slimmed = slimManifestBuffer(data);
      if (slimmed && slimmed.length <= maxObjectBytes) {
        data = slimmed;
        console.warn(`[clone storage] slimmed oversized manifest.json ${size} → ${data.length} bytes`);
      } else if (slimmed) {
        data = Buffer.from(JSON.stringify({
          targetOrigin: '',
          capturedAt: new Date().toISOString(),
          pages: [],
          truncated: true,
        }), 'utf8');
        console.warn(`[clone storage] replaced oversized manifest.json with stub (${size} bytes original)`);
      }
    }
    // Tiny JSON metadata: prefer DB text store first (avoids Free-tier Storage size quirks).
    if (isRouteMap && data.length <= 900_000) {
      try {
        await saveCloneTextFile(storagePath, data.toString('utf8'));
        // Also mirror under legacy prefix for older readers.
        const legacyPath = `${legacyCloneStoragePrefix(outDir)}/route-map.json`;
        if (legacyPath !== storagePath) {
          await saveCloneTextFile(legacyPath, data.toString('utf8')).catch(() => {});
        }
        fallbackSaved++;
        uploaded++;
      } catch (textErr) {
        failures.push(`${file.rel}: ${textErr?.message || textErr}`);
      }
      // Best-effort Storage copy; never fail the clone if text save succeeded.
      try {
        if (data.length <= maxObjectBytes) {
          await uploadCloneFileWithRetry(storagePath, data, contentTypeForPath(file.rel), 3);
        }
      } catch {}
      return;
    }
    if (data.length > maxObjectBytes) {
      if (isManifest) {
        skipped++;
        return;
      }
      failures.push(`${file.rel}: exceeds storage size cap (${data.length} bytes)`);
      return;
    }
    try {
      await uploadCloneFileWithRetry(storagePath, data, contentTypeForPath(file.rel), isRequiredCritical ? 6 : 4);
      uploaded++;
    } catch (err) {
      const msg = String(err?.message || err);
      if (isManifest) {
        console.warn(`[clone storage] optional ${file.rel} skipped: ${msg}`);
        return;
      }
      if (isRequiredCritical && data.length <= 900_000) {
        try {
          await saveCloneTextFile(storagePath, data.toString('utf8'));
          fallbackSaved++;
          uploaded++;
          console.warn(`[clone storage] ${file.rel} saved via text fallback after: ${msg}`);
          return;
        } catch (fallbackErr) {
          failures.push(`${file.rel}: ${msg}`);
          failures.push(`${file.rel} fallback: ${fallbackErr?.message || fallbackErr}`);
          return;
        }
      }
      failures.push(`${file.rel}: ${msg}`);
    }
  };
  const runLimited = async (items, limit = 8) => {
    for (let i = 0; i < items.length; i += limit) {
      await Promise.all(items.slice(i, i + limit).map(uploadOne));
    }
  };

  const criticalFiles = files.filter(file => file.rel === 'route-map.json' || file.rel === 'manifest.json' || file.rel.startsWith('captured-pages/'));
  const assetFiles = files.filter(file => !criticalFiles.includes(file))
    // Prefer smaller CSS/fonts/icons first so preview CSS resolves sooner.
    .sort((a, b) => {
      try { return statSync(a.abs).size - statSync(b.abs).size; } catch { return 0; }
    });

  if (!assetsOnly) {
    if (!criticalFiles.some((f) => f.rel.startsWith('captured-pages/') && f.rel.endsWith('.html'))) {
      if (requireCritical) throw new Error('No captured HTML pages found on disk to persist');
      return { uploaded: 0, total: files.length, deferred: 0, critical: 0 };
    }
    await runLimited(criticalFiles, IS_HOSTED ? 4 : 8);
    // Prefer matching the start of "rel: message" failure strings.
    // manifest.json is optional — oversized manifests must not fail the clone.
    const requiredFail = failures.filter((f) => {
      const rel = String(f).split(':')[0] || '';
      return rel === 'route-map.json' || rel.startsWith('captured-pages/');
    });
    if (requireCritical && requiredFail.length) {
      throw new Error(`Failed to save clone pages to storage: ${requiredFail[0]}`);
    }
    try {
      await saveCloneTextFile(cloneFileListStoragePath(outDir), JSON.stringify(criticalFiles.map(file => ({
        rel: file.rel,
        size: statSync(file.abs).size,
        contentType: contentTypeForPath(file.rel),
      }))));
      // Also write under legacy prefix so older readers can find the list.
      const legacyList = `${legacyCloneStoragePrefix(outDir)}/__files.json`;
      if (legacyList !== cloneFileListStoragePath(outDir)) {
        await saveCloneTextFile(legacyList, JSON.stringify(criticalFiles.map(file => ({
          rel: file.rel,
          size: statSync(file.abs).size,
          contentType: contentTypeForPath(file.rel),
        })))).catch(() => {});
      }
    } catch (err) {
      failures.push(`__files.json critical: ${err?.message || err}`);
      if (requireCritical) throw new Error(`Failed to save clone file index: ${err?.message || err}`);
    }
  }

  const finishAssets = async () => {
    await runLimited(assetFiles, IS_HOSTED ? 4 : 8);
    try {
      await saveCloneTextFile(cloneFileListStoragePath(outDir), JSON.stringify(files.map(file => ({
        rel: file.rel,
        size: statSync(file.abs).size,
        contentType: contentTypeForPath(file.rel),
      }))));
    } catch (err) {
      failures.push(`__files.json: ${err?.message || err}`);
    }
    console.log(`[clone storage] uploaded ${uploaded}/${files.length} files, skipped=${skipped}, fallback=${fallbackSaved} for ${outDir}`);
    if (failures.length) console.warn(`[clone storage] ${failures.slice(0, 5).join(' | ')}`);
  };

  if (deferAssets && !assetsOnly) {
    console.log(`[clone storage] critical ${criticalFiles.length} files uploaded; deferring ${assetFiles.length} assets for ${outDir}`);
    void finishAssets().catch((err) => console.warn(`[clone storage] background assets failed: ${err?.message || err}`));
    return { uploaded, total: files.length, deferred: assetFiles.length, critical: criticalFiles.length };
  }

  await finishAssets();
  return { uploaded, total: files.length, deferred: 0, critical: criticalFiles.length };
}

async function readCloneFile(outDir, relPath) {
  const normalized = normalizeCloneRelPath(relPath);
  const localPath = join(outDir, normalized);
  if (isInsideOutputDir(localPath) && existsSync(localPath)) return readFileSync(localPath);
  for (const storagePath of cloneStoragePathCandidates(outDir, normalized)) {
    const stored = await downloadCloneFile(storagePath);
    if (stored) return stored;
    if (normalized === 'route-map.json' || normalized === 'manifest.json' || normalized.startsWith('captured-pages/')) {
      const text = await getCloneTextFile(storagePath);
      if (text != null) return Buffer.from(text, 'utf8');
    }
  }
  return null;
}

async function writeCloneFile(outDir, relPath, bytes, contentType = contentTypeForPath(relPath)) {
  const normalized = normalizeCloneRelPath(relPath);
  const buffer = Buffer.isBuffer(bytes) ? bytes : Buffer.from(String(bytes ?? ''), 'utf8');
  const localPath = join(outDir, normalized);
  if (isInsideOutputDir(localPath) && existsSync(outDir)) {
    mkdirSync(dirname(localPath), { recursive: true });
    writeFileSync(localPath, buffer);
  }
  const storagePath = cloneStoragePath(outDir, normalized);
  try {
    await uploadCloneFileWithRetry(storagePath, buffer, contentType, 5);
  } catch {
    if ((contentType.startsWith('text/') || contentType.includes('json')) && buffer.length <= 900_000) {
      await saveCloneTextFile(storagePath, buffer.toString('utf8'));
    } else {
      throw new Error('Could not persist clone file');
    }
  }
  const files = await readPersistedCloneFileList(outDir);
  const next = files.filter(f => f.rel !== normalized);
  next.push({ rel: normalized, size: buffer.length, contentType });
  await saveCloneTextFile(cloneFileListStoragePath(outDir), JSON.stringify(next));
}

function jobStoragePath(id) {
  return `job:${id}`;
}

function jobSnapshot(job) {
  return {
    ...job,
    logs: Array.isArray(job.logs) ? job.logs.slice(-500) : [],
  };
}

const persistJobTimers = new Map();
function persistJob(job, { force = false } = {}) {
  const id = job?.id;
  if (!id) return;
  const write = () => {
    persistJobTimers.delete(id);
    saveCloneTextFile(jobStoragePath(id), JSON.stringify(jobSnapshot(job))).catch(() => {});
  };
  if (force || job.status !== 'running') {
    const pending = persistJobTimers.get(id);
    if (pending) clearTimeout(pending);
    persistJobTimers.delete(id);
    write();
    return;
  }
  if (persistJobTimers.has(id)) return;
  persistJobTimers.set(id, setTimeout(write, 2500));
}

async function readPersistedJob(id) {
  const raw = await getCloneTextFile(jobStoragePath(id)).catch(() => null);
  if (!raw) return null;
  try {
    const job = JSON.parse(raw);
    // If the job was persisted as running but has no live process, the server
    // restarted mid-job. Mark it as errored so the UI doesn't spin forever.
    if (isActiveJob(job) && !jobs.has(id)) {
      job.status = 'error';
      job.logs = [...(job.logs || []), '[ERROR] Clone was interrupted — server restarted while this job was running.'];
    }
    return job;
  } catch { return null; }
}

async function readPersistedCloneFileList(outDir) {
  let raw = null;
  for (const listPath of cloneStoragePathCandidates(outDir, '__files.json')) {
    raw = await getCloneTextFile(listPath).catch(() => null);
    if (raw) break;
  }
  if (!raw) {
    const map = await loadRouteMapAsync(outDir);
    if (!map) return [];
    const rels = new Set(['route-map.json']);
    for (const filename of Object.values(map)) {
      if (filename) rels.add(`captured-pages/${String(filename).replace(/\\/g, '/')}`);
    }
    for (const rel of [...rels].filter(r => r.startsWith('captured-pages/'))) {
      const data = await readCloneFile(outDir, rel);
      const html = data ? data.toString('utf8') : '';
      for (const match of html.matchAll(/["'(]\/_assets\/([^"'()?#]+)/g)) {
        try { rels.add(`public/_assets/${decodeURIComponent(match[1])}`); }
        catch { rels.add(`public/_assets/${match[1]}`); }
      }
    }
    return [...rels].map(rel => ({ rel, size: 0, contentType: contentTypeForPath(rel) }));
  }
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.map(f => {
          try { return { ...f, rel: normalizeCloneRelPath(f?.rel) }; }
          catch { return null; }
        }).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

/** True when a clone dir has at least one non-empty captured HTML page. */
function cloneOutputHasPages(dir) {
  if (!dir || !existsSync(dir)) return false;
  const pagesDir = join(dir, 'captured-pages');
  if (!existsSync(pagesDir)) return false;
  try {
    for (const entry of readdirSync(pagesDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.html')) continue;
      if (/^(login|register)\.html$/i.test(entry.name)) continue;
      if (statSync(join(pagesDir, entry.name)).size > 0) return true;
    }
  } catch {}
  return false;
}

async function materializeCloneOutput(outDir) {
  outDir = resolveCloneOutDir(outDir) || outDir;
  if (!isInsideOutputDir(outDir)) throw new Error('Invalid output folder');
  // Local dir may exist but be empty/incomplete (e.g. ephemeral disk wiped mid-flight,
  // or a leftover empty folder). Only trust it when real page HTML is present.
  if (existsSync(outDir) && cloneOutputHasPages(outDir)) {
    return { dir: outDir, cleanup: () => {} };
  }
  if (existsSync(outDir) && !cloneOutputHasPages(outDir)) {
    try { rmSync(outDir, { recursive: true, force: true }); } catch {}
  }
  const files = await readPersistedCloneFileList(outDir);
  if (!files.length) throw new Error('Output folder not found');
  const tempDir = join(OUTPUT_DIR, `__materialized_${randomUUID().slice(0, 8)}`);
  mkdirSync(tempDir, { recursive: true });
  try {
    for (const file of files) {
      let rel;
      try { rel = normalizeCloneRelPath(file.rel); }
      catch { continue; }
      const data = await readCloneFile(outDir, rel);
      if (!data) continue;
      const dest = join(tempDir, rel);
      if (!isInsideDir(tempDir, dest)) continue;
      mkdirSync(dirname(dest), { recursive: true });
      writeFileSync(dest, data);
    }
    if (!cloneOutputHasPages(tempDir)) {
      throw new Error('Clone pages could not be loaded for export. Open Run Preview first, then try Export Code again.');
    }
    return {
      dir: tempDir,
      cleanup: () => { try { rmSync(tempDir, { recursive: true, force: true }); } catch {} },
    };
  } catch (err) {
    try { rmSync(tempDir, { recursive: true, force: true }); } catch {}
    throw err;
  }
}

function loadRouteMap(outDir) {
  if (!isInsideOutputDir(outDir)) return null;
  const mapPath = join(outDir, 'route-map.json');
  if (!existsSync(mapPath)) return null;
  try { return JSON.parse(readFileSync(mapPath, 'utf8')); }
  catch { return null; }
}

async function loadRouteMapAsync(outDir) {
  const local = loadRouteMap(outDir);
  if (local) return local;
  if (!isInsideOutputDir(outDir)) return null;
  const data = await readCloneFile(outDir, 'route-map.json');
  if (!data) return null;
  try { return JSON.parse(data.toString('utf8')); }
  catch { return null; }
}

function inferredRouteFromPageFilename(filename) {
  const name = String(filename || '').replace(/\\/g, '/').split('/').pop() || '';
  if (!name.endsWith('.html')) return null;
  if (name === '__home__.html' || name === 'index.html') return '/';
  const base = name.slice(0, -5).replace(/^_+|_+$/g, '').replace(/_+/g, '-');
  return base ? `/${base}` : null;
}

async function inferRouteMapFromCapturedPages(outDir) {
  if (!isInsideOutputDir(outDir)) return null;
  const map = {};
  const pagesDir = join(outDir, 'captured-pages');
  if (existsSync(pagesDir)) {
    for (const entry of readdirSync(pagesDir, { withFileTypes: true })) {
      if (!entry.isFile() || !entry.name.endsWith('.html')) continue;
      const route = inferredRouteFromPageFilename(entry.name);
      if (route) map[route] = entry.name;
    }
  }
  if (!Object.keys(map).length) {
    const files = await readPersistedCloneFileList(outDir).catch(() => []);
    for (const file of files) {
      const rel = String(file?.rel || '').replace(/\\/g, '/');
      if (!rel.startsWith('captured-pages/') || !rel.endsWith('.html')) continue;
      const filename = rel.slice('captured-pages/'.length);
      const route = inferredRouteFromPageFilename(filename);
      if (route) map[route] = filename;
    }
  }
  return Object.keys(map).length ? map : null;
}

async function verifyCloneReadable(outDir) {
  const map = await loadRouteMapAsync(outDir) || await inferRouteMapFromCapturedPages(outDir);
  if (!map || !Object.keys(map).length) return { ok: false, error: 'route-map.json is not readable' };
  for (const filename of Object.values(map)) {
    if (!filename) return { ok: false, error: 'A captured route has no page file' };
    const page = await readCloneFile(outDir, join('captured-pages', filename));
    if (!page || !page.length) return { ok: false, error: `Captured page missing: ${filename}` };
  }
  return { ok: true, pages: Object.keys(map).length };
}

/**
 * On hosted hosts, require pages to be reachable WITHOUT relying on ephemeral local disk.
 * Temporarily ignore local files by reading storage candidates only.
 */
async function verifyCloneReadableFromStorage(outDir) {
  const tryStorage = async (relPath) => {
    for (const storagePath of cloneStoragePathCandidates(outDir, relPath)) {
      const stored = await downloadCloneFile(storagePath);
      if (stored?.length) return stored;
      if (relPath === 'route-map.json' || relPath === 'manifest.json' || relPath.startsWith('captured-pages/')) {
        const text = await getCloneTextFile(storagePath);
        if (text != null && text.length) return Buffer.from(text, 'utf8');
      }
    }
    return null;
  };
  const mapData = await tryStorage('route-map.json');
  if (!mapData) return { ok: false, error: 'route-map.json not found in storage' };
  let map;
  try { map = JSON.parse(mapData.toString('utf8')); }
  catch { return { ok: false, error: 'route-map.json in storage is invalid JSON' }; }
  const entries = Object.entries(map || {}).filter(([, f]) => f);
  if (!entries.length) return { ok: false, error: 'route-map.json in storage has no pages' };
  for (const [, filename] of entries) {
    const page = await tryStorage(capturedPageStorageRel(filename));
    if (!page?.length) return { ok: false, error: `Storage missing page: ${filename}` };
  }
  return { ok: true, pages: entries.length };
}

function addAssetMapVariants(map, from, to) {
  const add = (key, value) => { if (key && value && key !== '/') map[key] = value; };
  add(from, to);
  add(from.split('?')[0].split('#')[0], to);
  try {
    const u = new URL(from);
    add(`${u.pathname}${u.search}${u.hash}`, to);
    add(`${u.pathname}${u.search}`, to);
    add(u.pathname, to);
  } catch {}
}

async function buildPreviewAssetContext(outDir) {
  const prefix = `/api/asset?outDir=${encodeURIComponent(outDir)}&assetToken=${cloneAssetToken(outDir)}&path=`;
  const map = {};
  const originalByRelPath = {};
  const manifestData = await readCloneFile(outDir, 'manifest.json').catch(() => null);
  const manifest = manifestData ? safeJsonParse(manifestData.toString('utf8'), null) : null;
  const targetOrigin = String(manifest?.targetOrigin || '').replace(/\/$/, '');
  for (const page of manifest?.pages || []) {
    for (const asset of page.assets || []) {
      const original = String(asset.originalUrl || '');
      const local = String(asset.localPath || '');
      if (!original || !local) continue;
      const assetRel = local.replace(/^\/+/, '');
      const target = `${prefix}${encodeURIComponent(assetRel)}`;
      originalByRelPath[assetRel] = original;
      addAssetMapVariants(map, original, target);
      addAssetMapVariants(map, local, target);
      addAssetMapVariants(map, local.replace(/^\/+/, ''), target);
    }
  }
  return { map, targetOrigin, originalByRelPath };
}

function rewriteCssUrlsForPreview(css, assetMap, baseUrl) {
  const mapUrl = (rawUrl) => {
    const clean = String(rawUrl || '').split('?')[0].split('#')[0];
    if (assetMap.has(rawUrl)) return assetMap.get(rawUrl);
    if (assetMap.has(clean)) return assetMap.get(clean);
    if (baseUrl) {
      try {
        const abs = new URL(rawUrl, baseUrl).href;
        const absClean = abs.split('?')[0].split('#')[0];
        return assetMap.get(abs) || assetMap.get(absClean) || null;
      } catch {}
    }
    return null;
  };
  return String(css)
    .replace(/url\(\s*(['"]?)([^'")\s]+)\1\s*\)/g, (match, quote, rawUrl) => {
      const mapped = mapUrl(rawUrl);
      return mapped ? `url(${quote}${mapped}${quote})` : match;
    })
    .replace(/@import\s+(?:url\(\s*)?(?:(['"])([^'")]+)\1|([^'")\s;]+))\s*\)?/g, (match, _quote, quotedUrl, bareUrl) => {
      const rawUrl = quotedUrl || bareUrl;
      const mapped = mapUrl(rawUrl);
      return mapped ? match.replace(rawUrl, mapped) : match;
    });
}

async function rewritePreviewCssAsset(css, outDir, relPath) {
  const { map, originalByRelPath } = await buildPreviewAssetContext(outDir);
  const assetMap = new Map(Object.entries(map));
  const baseUrl = originalByRelPath[relPath] || originalByRelPath[relPath.replace(/^public\//, '')] || undefined;
  return rewriteCssUrlsForPreview(css, assetMap, baseUrl);
}

function previewReplayPatch(assetMap, targetOrigin = '') {
  return `<script data-clonyfy-preview-replay>
(() => {
  const assetMap = ${JSON.stringify(assetMap)};
  const targetOrigin = ${JSON.stringify(targetOrigin)};
  const localize = (value) => {
    if (!value) return value;
    const s = String(value);
    if (assetMap[s]) return assetMap[s];
    try {
      const url = new URL(s, window.location.href);
      const mapped = assetMap[url.href] || assetMap[url.pathname + url.search + url.hash] || assetMap[url.pathname + url.search] || assetMap[url.pathname];
      if (mapped) return mapped;
      if (targetOrigin && url.pathname.startsWith('/media/')) {
        const nextMediaPath = '/_next/static' + url.pathname;
        return assetMap[nextMediaPath + url.search] || assetMap[nextMediaPath] || (targetOrigin + nextMediaPath + url.search + url.hash);
      }
      if (targetOrigin && url.pathname === '/_next/image') return targetOrigin + url.pathname + url.search + url.hash;
      return s;
    } catch {}
    return s;
  };
  const rewriteSrcset = (value) => String(value || '').split(',').map((part) => {
    const trimmed = part.trim();
    const spaceIdx = trimmed.search(/\\s/);
    if (spaceIdx === -1) return localize(trimmed);
    return localize(trimmed.slice(0, spaceIdx)) + trimmed.slice(spaceIdx);
  }).join(', ');
  const nativeSetAttribute = Element.prototype.setAttribute;
  Element.prototype.setAttribute = function(name, value) {
    const key = String(name || '').toLowerCase();
    if (key === 'src' || key === 'href' || key === 'poster' || key === 'action' || key === 'data') value = localize(value);
    else if (key === 'srcset' || key === 'imagesrcset') value = rewriteSrcset(value);
    else if (key === 'style') value = rewriteCssText(value);
    return nativeSetAttribute.call(this, name, value);
  };
  const patchUrlProperty = (proto, prop) => {
    const desc = Object.getOwnPropertyDescriptor(proto, prop);
    if (!desc || !desc.set || !desc.get) return;
    Object.defineProperty(proto, prop, {
      configurable: true,
      enumerable: desc.enumerable,
      get() { return desc.get.call(this); },
      set(value) { return desc.set.call(this, localize(value)); },
    });
  };
  patchUrlProperty(HTMLScriptElement.prototype, 'src');
  patchUrlProperty(HTMLLinkElement.prototype, 'href');
  patchUrlProperty(HTMLImageElement.prototype, 'src');
  patchUrlProperty(HTMLImageElement.prototype, 'srcset');
  if (window.HTMLSourceElement) {
    patchUrlProperty(HTMLSourceElement.prototype, 'src');
    patchUrlProperty(HTMLSourceElement.prototype, 'srcset');
  }
  if (window.HTMLMediaElement) patchUrlProperty(HTMLMediaElement.prototype, 'src');
  if (window.HTMLVideoElement) patchUrlProperty(HTMLVideoElement.prototype, 'poster');
  if (window.HTMLIFrameElement) patchUrlProperty(HTMLIFrameElement.prototype, 'src');
  if (window.HTMLObjectElement) patchUrlProperty(HTMLObjectElement.prototype, 'data');
  if (window.HTMLEmbedElement) patchUrlProperty(HTMLEmbedElement.prototype, 'src');
  if (window.HTMLFormElement) patchUrlProperty(HTMLFormElement.prototype, 'action');

  function rewriteCssText(value) {
    return String(value || '').replace(/url\\(\\s*(['"]?)([^'")\\s]+)\\1\\s*\\)/g, (match, quote, url) => {
      const next = localize(url);
      return next === url ? match : 'url(' + quote + next + quote + ')';
    });
  }

  if (window.CSSStyleDeclaration) {
    const nativeSetProperty = CSSStyleDeclaration.prototype.setProperty;
    CSSStyleDeclaration.prototype.setProperty = function(name, value, priority) {
      return nativeSetProperty.call(this, name, rewriteCssText(value), priority);
    };
    const bgDesc = Object.getOwnPropertyDescriptor(CSSStyleDeclaration.prototype, 'backgroundImage');
    if (bgDesc && bgDesc.set && bgDesc.get) {
      Object.defineProperty(CSSStyleDeclaration.prototype, 'backgroundImage', {
        configurable: true,
        enumerable: bgDesc.enumerable,
        get() { return bgDesc.get.call(this); },
        set(value) { return bgDesc.set.call(this, rewriteCssText(value)); },
      });
    }
  }
  if (window.CSSStyleSheet) {
    const nativeInsertRule = CSSStyleSheet.prototype.insertRule;
    CSSStyleSheet.prototype.insertRule = function(rule, index) {
      return nativeInsertRule.call(this, rewriteCssText(rule), index);
    };
  }
})();
</script>`;
}

function previewNavigationPatch(outDir, targetOrigin = '') {
  const apiBase = `/api/page?outDir=${encodeURIComponent(outDir)}&route=`;
  return `<script data-clonyfy-preview-nav>
(() => {
  const apiBase = ${JSON.stringify(apiBase)};
  const targetOrigin = ${JSON.stringify(String(targetOrigin || '').replace(/\/$/, ''))};
  const previewUrl = (value) => {
    if (!value || /^#/.test(String(value))) return value;
    try {
      const url = new URL(value, location.href);
      if (url.pathname === '/api/page' || url.pathname.startsWith('/api/') || url.pathname.startsWith('/_assets/')) return value;
      if (url.origin === location.origin || (targetOrigin && url.origin === targetOrigin)) {
        const route = (url.pathname || '/') + url.search;
        return apiBase + encodeURIComponent(route === '' ? '/' : route) + url.hash;
      }
    } catch {}
    return value;
  };
  const notifyParent = (route) => {
    try { window.parent.postMessage({ type: 'clonyfy-preview-nav', route }, '*'); } catch {}
  };
  const go = (next, routeHint) => {
    if (!next) return;
    try {
      const parsed = new URL(next, location.href);
      const route = routeHint || decodeURIComponent(parsed.searchParams.get('route') || parsed.pathname || '/');
      notifyParent(route);
    } catch {}
    location.href = next;
  };
  const linkFromEvent = (event) => {
    let el = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!el) {
      el = event.target && event.target.closest
        ? event.target.closest('nav [href], header [href], [role="navigation"] [href], [role="link"][href], [data-href], [data-url], [data-link]')
        : null;
    }
    if (!el) return null;
    const href = el.getAttribute('href') || el.getAttribute('data-href') || el.getAttribute('data-url') || el.getAttribute('data-link');
    return href ? { el, href } : null;
  };
  document.addEventListener('click', (event) => {
    const link = linkFromEvent(event);
    if (!link) return;
    const a = link.el;
    if (a.target || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const next = previewUrl(link.href);
    if (next && next !== link.href) {
      event.preventDefault();
      event.stopPropagation();
      go(next);
    }
  }, true);
  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!form || !form.getAttribute) return;
    const next = previewUrl(form.getAttribute('action') || location.href);
    if (next && next !== form.getAttribute('action')) form.setAttribute('action', next);
  }, true);
  for (const name of ['pushState', 'replaceState']) {
    const native = history[name];
    history[name] = function(state, title, url) {
      if (url != null) {
        const next = previewUrl(url);
        if (next && next !== url) {
          notifyParent(decodeURIComponent(new URL(next, location.href).searchParams.get('route') || '/'));
        }
        url = next;
      }
      return native.call(this, state, title, url);
    };
  }
  try {
    const nativeOpen = window.open;
    window.open = function(url, target, features) {
      return nativeOpen.call(window, previewUrl(url), target, features);
    };
  } catch {}
  try {
    const nativeAssign = Location.prototype.assign;
    const nativeReplace = Location.prototype.replace;
    Location.prototype.assign = function(url) { return nativeAssign.call(this, previewUrl(url)); };
    Location.prototype.replace = function(url) { return nativeReplace.call(this, previewUrl(url)); };
  } catch {}
})();
</script>`;
}

async function previewOutDirFromReferer(req) {
  const raw = String(req.headers.referer || '');
  if (!raw) return '';
  try {
    const ref = new URL(raw);
    if (ref.pathname.startsWith('/share/')) {
      const shareId = ref.pathname.slice(7).split('/')[0].replace(/[^a-z0-9]/gi, '');
      const share = shareId ? await getShare(shareId) : null;
      return share?.out_dir || '';
    }
    if (ref.pathname === '/api/share-page') {
      const sid = String(ref.searchParams.get('shareId') || '').replace(/[^a-z0-9]/gi, '');
      const share = sid ? await getShare(sid) : null;
      return share?.out_dir || '';
    }
    if (ref.pathname === '/api/page' || ref.pathname === '/api/asset') return ref.searchParams.get('outDir') || '';
  } catch {}
  return '';
}

function previewScrollAnimationsPatch() {
  return buildScrollAnimationsPatchHtml();
}

function rewriteBareAssetUrls(html, outDir) {
  const prefix = `/api/asset?outDir=${encodeURIComponent(outDir)}&assetToken=${cloneAssetToken(outDir)}&path=`;
  // Rewrite every bare /_assets/ path — the old quote-only regex missed srcset
  // candidates after the first comma (", /_assets/foo.png 640w").
  return String(html).replace(/\/_assets\//g, `${prefix}${encodeURIComponent('_assets/')}`);
}

/** Undo preview-only asset proxy URLs so exported / local Next apps use /_assets/ paths. */
function revertPreviewAssetUrls(html) {
  let out = String(html || '');
  out = out.replace(/\/api\/asset\?[^"'>\s]*?\bpath=([^"'>&\s]+)/gi, (_m, encoded) => {
    try {
      const decoded = decodeURIComponent(String(encoded).replace(/\+/g, ' '));
      if (decoded.startsWith('/')) return decoded;
      if (decoded.startsWith('_assets/')) return `/${decoded}`;
      return `/${decoded}`;
    } catch {
      return '/_assets/';
    }
  });
  return out;
}

function sanitizeStoredCloneHtml(html) {
  let out = revertPreviewAssetUrls(html);
  out = stripPreviewNavigationPatch(out);
  out = out.replace(/<base\b[^>]*>/gi, '');
  return out;
}

/**
 * Neutralize original-site JS for preview/share. Captured HTML is already the
 * post-render DOM; re-running React/Remix/Next hydration on a foreign origin
 * (e.g. Shopify) replaces the page with their "Application Error" boundary.
 * Keep Clonyfy patches + JSON-LD / importmap metadata executable.
 */
function neutralizeCloneScripts(html) {
  let out = String(html || '');
  out = out.replace(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi, (match, attrs = '', body = '') => {
    if (/data-clonyfy-/i.test(attrs) || /id\s*=\s*["']__clonyfy_/i.test(attrs)) return match;
    if (/data-clonyfy-disabled-script/i.test(attrs)) return match;
    if (/\btype\s*=\s*["']application\/(?:ld\+json|json)["']/i.test(attrs)) return match;
    if (/\btype\s*=\s*["']importmap["']/i.test(attrs)) return match;

    let nextAttrs = String(attrs);
    const typeMatch = nextAttrs.match(/\btype\s*=\s*(["'])(.*?)\1/i);
    if (typeMatch) {
      nextAttrs = nextAttrs.replace(/\btype\s*=\s*(["']).*?\1/i, '');
      nextAttrs += ` data-clonyfy-original-type="${String(typeMatch[2]).replace(/"/g, '&quot;')}"`;
    }
    nextAttrs += ' data-clonyfy-disabled-script="true" type="text/plain"';
    return `<script${nextAttrs}>${body}</script>`;
  });
  // Stop browsers from fetching framework bundles before our neutralize runs.
  out = out.replace(/<link\b([^>]*)>/gi, (match, attrs = '') => {
    const a = String(attrs);
    const isModulePreload = /\brel\s*=\s*["']modulepreload["']/i.test(a);
    const isScriptPreload = /\brel\s*=\s*["']preload["']/i.test(a) && /\bas\s*=\s*["']script["']/i.test(a);
    if (!isModulePreload && !isScriptPreload) return match;
    return `<!--clonyfy-disabled-script-preload ${match.replace(/<!--/g, '').replace(/-->/g, '')}-->`;
  });
  return out;
}

function stripPreviewNavigationPatch(html) {
  return String(html).replace(/<script\b[^>]*\bdata-clonyfy-preview-nav\b[^>]*>[\s\S]*?<\/script>/gi, '');
}

function previewVisibilityFix(baseHref = '/') {
  return buildVisibilityPatchHtml(baseHref);
}

async function rewritePreviewAssetUrls(html, outDir, options = {}) {
  const {
    baseHref = '/',
    injectPreviewNav = true,
    injectScrollReveal = true,
    assetContext = null,
  } = options;
  let out = rewriteBareAssetUrls(html, outDir);
  // Force-show body even if the original site relies on JS hydration to reveal
  // content. Many SSG/SPA sites ship initial HTML with opacity:0 / visibility:hidden
  // and only reveal once React hydrates — but in a clone the hydration JS often
  // fails (CORS, missing chunks), leaving the page invisible. Inject a tiny CSS
  // override that forces visible state, and a tiny script that strips common
  // "loading" classes from <html>.
  // <base href="..."> forces relative URLs in cloned HTML to resolve against a
  // stable path (`/` for /api/page preview, `/share/{id}/` for public shares).
  const visibilityFix = previewVisibilityFix(baseHref);
  // Inject right after opening <head>, so a captured <base> (if any) doesn't override ours.
  if (out.match(/<head[^>]*>/i)) out = out.replace(/<head[^>]*>/i, m => `${m}${visibilityFix}`);
  else if (out.includes('<html')) out = out.replace(/<html[^>]*>/i, m => `${m}<head>${visibilityFix}</head>`);
  else out = `<head>${visibilityFix}</head>` + out;

  // Resolve the clone's original origin once (used for media rewrite + replay/nav patches).
  const context = assetContext || await buildPreviewAssetContext(outDir);
  const targetOrigin = context.targetOrigin;

  // Point un-captured root-relative media/asset paths back to the original origin.
  // This works in BOTH the preview iframe (`/api/page` src) and the editor iframe
  // (`about:srcdoc`, where the Referer-based proxy fallback can't fire). We only
  // touch file-looking paths (known media/asset extensions) and never `/_assets/`,
  // `/api/`, protocol-relative `//`, or HTML routes — so navigation links are safe.
  if (targetOrigin && /^https?:\/\//.test(targetOrigin)) {
    const MEDIA_EXT = 'mp4|webm|ogg|ogv|mov|m4v|mp3|wav|m4a|flac|jpg|jpeg|png|gif|svg|webp|avif|ico|bmp|woff2?|ttf|eot|otf|pdf|css';
    const attrRe = new RegExp(
      `(\\b(?:src|href|poster|data-src|data-lazy-src|data-original|data-bg|data-image)\\s*=\\s*["'])(/(?!_assets/|api/|/)[^"'?#\\s]*\\.(?:${MEDIA_EXT}))`,
      'gi',
    );
    out = out.replace(attrRe, (_m, attr, path) => `${attr}${targetOrigin}${path}`);
    // srcset can carry several comma-separated candidates with width descriptors.
    const extTest = new RegExp(`\\.(?:${MEDIA_EXT})$`, 'i');
    out = out.replace(/(\bsrcset\s*=\s*["'])([^"']+)(["'])/gi, (_m, pre, val, post) => {
      const fixed = val.split(',').map((part) => {
        const seg = part.trim();
        if (!seg) return seg;
        const sp = seg.search(/\s/);
        const url = sp === -1 ? seg : seg.slice(0, sp);
        const desc = sp === -1 ? '' : seg.slice(sp);
        if (/^\/(?!_assets\/|api\/|\/)/.test(url) && extTest.test(url.split(/[?#]/)[0])) {
          return `${targetOrigin}${url}${desc}`;
        }
        return seg;
      }).join(', ');
      return `${pre}${fixed}${post}`;
    });
  }

  if (!out.includes('data-clonyfy-preview-replay')) {
    if (targetOrigin) {
      out = out
        .replace(/([("'=\s,])\/_next\/image\?/g, `$1${targetOrigin}/_next/image?`)
        .replace(/([("'=\s,])\/media\//g, `$1${targetOrigin}/_next/static/media/`);
    }
    const patch = previewReplayPatch(context.map, targetOrigin);
    if (out.includes('<head>')) out = out.replace('<head>', `<head>${patch}`);
    else if (out.includes('<head ')) out = out.replace(/(<head[^>]*>)/, `$1${patch}`);
    else out = patch + out;
  }
  if (injectPreviewNav && !out.includes('data-clonyfy-preview-nav')) {
    const navPatch = previewNavigationPatch(outDir, targetOrigin);
    if (out.includes('</body>')) out = out.replace('</body>', `${navPatch}</body>`);
    else out += navPatch;
  }
  if (injectScrollReveal && !out.includes('data-clonyfy-scroll-reveal')) {
    const scrollPatch = previewScrollAnimationsPatch();
    if (out.includes('</body>')) out = out.replace('</body>', `${scrollPatch}</body>`);
    else out += scrollPatch;
  }
  // Must run AFTER Clonyfy patches are injected so only original-site scripts die.
  return neutralizeCloneScripts(out);
}

async function cloneAssetDataUrl(outDir, relPath) {
  let storageRel;
  try { storageRel = assetStorageRel(relPath); } catch { return null; }
  if (!storageRel) return null;
  const bytes = await readCloneFile(outDir, storageRel).catch(() => null);
  if (!bytes?.length) return null;
  const assetName = storageRel.replace(/^public\/_assets\//, '');
  return `data:${contentTypeForPath(assetName)};base64,${bytes.toString('base64')}`;
}

/** Serve clone assets to headless Figma export without inlining (serverless-safe). */
async function readCloneAssetForFigmaExport(outDir, relPath) {
  let normalized;
  try { normalized = normalizeCloneRelPath(relPath, ['_assets', 'public/_assets']); }
  catch { return null; }
  const storageRel = assetStorageRel(normalized);
  if (!storageRel) return null;
  const data = await readCloneFile(outDir, storageRel).catch(() => null);
  if (!data?.length) return null;
  const assetName = storageRel.replace(/^public\/_assets\//, '');
  let contentType = contentTypeForPath(assetName);
  let body = data;
  if (contentType === 'application/octet-stream' && data.length) {
    const head = data.slice(0, 256).toString('utf8');
    if (/^\s*(\/\*|\/\/|!function|var |let |const |function |import |export |\(function|window\.|document\.|;|\(|\{)/.test(head)) {
      contentType = 'application/javascript';
    } else if (/^\s*([.#@a-zA-Z][^{]*\{|@(media|import|font-face|keyframes|charset))/.test(head)) {
      contentType = 'text/css';
    } else if (head.startsWith('<')) {
      contentType = 'text/html; charset=utf-8';
    }
  }
  if (contentType.startsWith('text/css')) {
    const css = await rewritePreviewCssAsset(data.toString('utf8'), outDir, storageRel.replace(/^public\//, '')).catch(() => data.toString('utf8'));
    body = Buffer.from(css, 'utf8');
  }
  return { body, contentType };
}

function figmaAssetReader(outDir) {
  return (relPath) => readCloneAssetForFigmaExport(outDir, relPath);
}

/** Inline cloned assets so headless Figma export can render the same HTML as preview. */
async function inlinePreviewAssetsForRender(html, outDir) {
  let out = String(html);
  out = out.replace(/<base\s+href=["']\/["']\s*\/?>/gi, '');
  const replacements = new Map();

  for (const match of out.matchAll(/\/api\/asset\?[^"')\s]+/g)) {
    const full = match[0];
    if (replacements.has(full)) continue;
    const pathMatch = full.match(/[?&]path=([^&"')\s]+)/);
    if (!pathMatch) continue;
    let rel;
    try { rel = decodeURIComponent(pathMatch[1]); } catch { continue; }
    let dataUrl = null;
    try { dataUrl = await cloneAssetDataUrl(outDir, rel); } catch {}
    if (dataUrl) replacements.set(full, dataUrl);
  }

  for (const match of out.matchAll(/\/_assets\/([A-Za-z0-9._%-]+)/g)) {
    const full = match[0];
    if (replacements.has(full)) continue;
    let name;
    try { name = decodeURIComponent(match[1]); } catch { name = match[1]; }
    let dataUrl = null;
    try { dataUrl = await cloneAssetDataUrl(outDir, `_assets/${name}`); } catch {}
    if (dataUrl) replacements.set(full, dataUrl);
  }

  for (const [from, to] of [...replacements.entries()].sort((a, b) => b[0].length - a[0].length)) {
    out = out.split(from).join(to);
  }
  return out;
}

async function prepareHtmlForFigmaExport(html, outDir) {
  // Do not inject scroll-reveal — it sets opacity:0 on layers and the Figma
  // exporter skips them, producing an empty scene.
  let out = await rewritePreviewAssetUrls(String(html), outDir, {
    injectPreviewNav: false,
    injectScrollReveal: false,
  });
  out = String(out)
    .replace(/<script[^>]*data-clonyfy-scroll-reveal[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*id="clonyfy-scroll-reveal-style"[^>]*>[\s\S]*?<\/style>/gi, '');
  // Hosted/low-memory: never inline dozens of assets as data-URLs (Shopify OOMs / times out).
  // Playwright serves assets via figmaAssetReader + route interception instead.
  if (IS_SERVERLESS || IS_HOSTED || IS_LOW_MEMORY) {
    return out;
  }
  out = await inlinePreviewAssetsForRender(out, outDir);
  return out;
}

function readRequestCookie(req, name) {
  const raw = String(req.headers.cookie || '');
  for (const part of raw.split(';')) {
    const trimmed = part.trim();
    if (!trimmed) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    if (trimmed.slice(0, eq) === name) {
      try { return decodeURIComponent(trimmed.slice(eq + 1)); } catch { return trimmed.slice(eq + 1); }
    }
  }
  return '';
}

function shareAccessCookieName(shareId) {
  return `clonyfy_share_${String(shareId || '').replace(/[^a-z0-9]/gi, '')}`;
}

function shareAccessToken(share) {
  if (!share?.password_hash) return '';
  return createHash('sha256').update(`${share.id}:${share.password_hash}:${SHARE_PASSWORD_PEPPER}`).digest('hex');
}

function hasShareAccess(req, share) {
  if (!share?.password_hash) return true;
  const token = readRequestCookie(req, shareAccessCookieName(share.id));
  const expected = shareAccessToken(share);
  if (!token || !expected) return false;
  try {
    const a = Buffer.from(token, 'utf8');
    const b = Buffer.from(expected, 'utf8');
    return a.length === b.length && timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function shareAccessSetCookie(share) {
  const token = shareAccessToken(share);
  return `${shareAccessCookieName(share.id)}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=86400`;
}

/** Same rewrite pipeline as /api/page preview, with share-aware in-frame navigation. */
async function prepareHtmlForSharePreview(html, outDir, shareId) {
  const context = await buildPreviewAssetContext(outDir);
  let out = await rewritePreviewAssetUrls(String(html), outDir, {
    baseHref: '/',
    injectPreviewNav: false,
  });
  out = stripPreviewNavigationPatch(out);
  if (!out.includes('data-clonyfy-share-nav')) {
    const patch = shareIframeNavigationPatch(shareId, context.targetOrigin);
    if (out.includes('</body>')) out = out.replace('</body>', `${patch}</body>`);
    else out += patch;
  }
  return out;
}

function shareIframeNavigationPatch(shareId, targetOrigin = '') {
  const sharePageBase = `/api/share-page?shareId=${encodeURIComponent(shareId)}&route=`;
  const sharePathBase = `/share/${shareId}`;
  return `<script data-clonyfy-share-nav>
(() => {
  const sharePageBase = ${JSON.stringify(sharePageBase)};
  const sharePathBase = ${JSON.stringify(sharePathBase)};
  const targetOrigin = ${JSON.stringify(String(targetOrigin || '').replace(/\/$/, ''))};
  const sharePageUrl = (value) => {
    if (!value || /^#/.test(String(value))) return value;
    try {
      const url = new URL(value, location.href);
      if (url.pathname === '/api/share-page' || url.pathname.startsWith('/api/asset') || url.pathname.startsWith('/_assets/')) return value;
      if (url.origin === location.origin || (targetOrigin && url.origin === targetOrigin)) {
        const route = (url.pathname || '/') + url.search + url.hash;
        const pageUrl = sharePageBase + encodeURIComponent(route === '' ? '/' : route);
        try {
          if (window.parent && window.parent !== window) {
            const sharePath = sharePathBase + (url.pathname === '/' ? '/' : url.pathname) + url.search + url.hash;
            window.parent.history.replaceState(null, '', sharePath);
          }
        } catch {}
        return pageUrl;
      }
    } catch {}
    return value;
  };
  document.addEventListener('click', (event) => {
    const a = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!a || a.target || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const next = sharePageUrl(a.getAttribute('href'));
    if (next && next !== a.getAttribute('href')) {
      event.preventDefault();
      location.href = next;
    }
  }, true);
  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!form || !form.getAttribute) return;
    const next = sharePageUrl(form.getAttribute('action') || location.href);
    if (next && next !== form.getAttribute('action')) form.setAttribute('action', next);
  }, true);
  for (const name of ['pushState', 'replaceState']) {
    const native = history[name];
    history[name] = function(state, title, url) {
      if (url != null) url = sharePageUrl(url);
      return native.call(this, state, title, url);
    };
  }
  try {
    const nativeOpen = window.open;
    window.open = function(url, target, features) {
      return nativeOpen.call(window, sharePageUrl(url), target, features);
    };
  } catch {}
  try {
    const nativeAssign = Location.prototype.assign;
    const nativeReplace = Location.prototype.replace;
    Location.prototype.assign = function(url) { return nativeAssign.call(this, sharePageUrl(url)); };
    Location.prototype.replace = function(url) { return nativeReplace.call(this, sharePageUrl(url)); };
  } catch {}
})();
</script>`;
}

function shareWrapperHtml(shareId, route = '/') {
  const cleanRoute = String(route || '/');
  const iframeSrc = `/api/share-page?shareId=${encodeURIComponent(shareId)}&route=${encodeURIComponent(cleanRoute)}`;
  return `<!DOCTYPE html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Shared preview</title>
<style>html,body{margin:0;height:100%;overflow:hidden;background:#0a0a0a}iframe{border:0;width:100%;height:100%;display:block}</style>
</head><body>
<iframe src="${htmlEsc(iframeSrc)}" title="Shared site preview" sandbox="allow-same-origin allow-scripts allow-forms allow-popups allow-modals allow-downloads"></iframe>
</body></html>`;
}

async function loadSharedPreviewHtml(share, shareId, requestedRoute) {
  const map = await loadRouteMapAsync(share.out_dir) || await inferRouteMapFromCapturedPages(share.out_dir);
  if (!map) return { error: 'Clone no longer exists', status: 404 };
  const defaultRoute = share.route || '/';
  const resolved = resolveSharedRoute(map, requestedRoute, defaultRoute);
  if (!resolved.filename) return { error: 'Route not found', status: 404 };
  let data;
  try { data = await readCloneFile(share.out_dir, join('captured-pages', resolved.filename)); }
  catch { return { error: 'Invalid page path', status: 400 }; }
  if (!data) return { error: 'Page file missing', status: 404 };
  const html = await prepareHtmlForSharePreview(data.toString('utf8'), share.out_dir, shareId);
  return { html, route: resolved.route };
}

function safeJsonParse(str, fallback = []) {
  try { return JSON.parse(str); } catch { return fallback; }
}

function htmlEsc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;',
  }[ch]));
}

function shareRouteFromPath(pathname, shareId, search = '') {
  let rest = pathname.slice(`/share/${shareId}`.length) || '/';
  try { rest = decodeURIComponent(rest); } catch {}
  rest = rest.replace(/\/+/g, '/');
  const route = rest.startsWith('/') ? rest : `/${rest}`;
  return search && search !== '?' ? `${route}${search}` : route;
}

function shareRouteCandidates(route) {
  const clean = route.split('#')[0].split('?')[0] || '/';
  const noSlash = clean.replace(/\/$/, '') || '/';
  const query = route.includes('?') ? route.slice(route.indexOf('?')) : '';
  const candidates = [route, clean, noSlash];
  if (query && clean !== '/') candidates.push(`${clean}${query}`, `${noSlash}${query}`);
  if (clean.endsWith('.html')) candidates.push(clean.slice(0, -5) || '/');
  else candidates.push(`${noSlash}.html`);
  candidates.push(`${noSlash}/index`, `${noSlash}/index.html`);
  return [...new Set(candidates)];
}

function resolveSharedRoute(map, requestedRoute, defaultRoute = '/') {
  const want = String(requestedRoute || defaultRoute || '/');
  for (const candidate of shareRouteCandidates(want)) {
    if (map[candidate]) return { route: candidate, filename: map[candidate] };
  }
  const normalizedWant = want.split('?')[0].split('#')[0].replace(/\/$/, '') || '/';
  const normalizedDefault = String(defaultRoute || '/').split('?')[0].split('#')[0].replace(/\/$/, '') || '/';
  if (normalizedWant === normalizedDefault || normalizedWant === '/') {
    if (map[defaultRoute]) return { route: defaultRoute, filename: map[defaultRoute] };
    if (map['/']) return { route: '/', filename: map['/'] };
  }
  return { route: want, filename: null };
}

function cloneMissingRouteHtml(requestedRoute, capturedRoutes = []) {
  const route = htmlEsc(requestedRoute || '/');
  const samples = capturedRoutes.slice(0, 12).map((r) => `<li><code>${htmlEsc(r)}</code></li>`).join('');
  const more = capturedRoutes.length > 12 ? `<p>…and ${capturedRoutes.length - 12} more captured routes.</p>` : '';
  return `<!doctype html><html><head><meta charset="utf-8"><title>Page not cloned</title>
<style>body{font-family:system-ui,-apple-system,sans-serif;background:#0b1220;color:#e8eefc;padding:40px;max-width:640px;margin:0 auto;line-height:1.5}
h1{font-size:22px;margin:0 0 12px}p{color:#9fb0d0;margin:0 0 16px}code{background:#1a2540;padding:2px 6px;border-radius:4px}ul{padding-left:20px}</style></head>
<body><h1>This page was not cloned</h1>
<p>The navbar link <code>${route}</code> points to a page that was not captured during cloning.</p>
<p>Try increasing <strong>Max pages</strong> and <strong>Depth</strong>, then re-clone. Or pick a captured route from the preview dropdown.</p>
${samples ? `<p>Captured routes include:</p><ul>${samples}</ul>${more}` : ''}
</body></html>`;
}

function sharedNavigationPatch(shareId, targetOrigin = '') {
  const shareBase = `/share/${shareId}`;
  return `<script data-clonyfy-share-nav>
(() => {
  const shareBase = ${JSON.stringify(shareBase)};
  const targetOrigin = ${JSON.stringify(String(targetOrigin || '').replace(/\/$/, ''))};
  const sameShare = (url) => url.origin === location.origin && url.pathname.startsWith(shareBase);
  const shareUrl = (value) => {
    if (!value || /^#/.test(String(value))) return value;
    try {
      const url = new URL(value, location.href);
      if (sameShare(url) || url.pathname.startsWith('/api/') || url.pathname.startsWith('/_assets/')) return value;
      if (url.origin === location.origin || (targetOrigin && url.origin === targetOrigin)) {
        return shareBase + (url.pathname === '/' ? '/' : url.pathname) + url.search + url.hash;
      }
    } catch {}
    return value;
  };
  document.addEventListener('click', (event) => {
    const a = event.target && event.target.closest ? event.target.closest('a[href]') : null;
    if (!a || a.target || event.defaultPrevented || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const next = shareUrl(a.getAttribute('href'));
    if (next && next !== a.getAttribute('href')) {
      event.preventDefault();
      location.href = next;
    }
  }, true);
  document.addEventListener('submit', (event) => {
    const form = event.target;
    if (!form || !form.getAttribute) return;
    const next = shareUrl(form.getAttribute('action') || location.href);
    if (next && next !== form.getAttribute('action')) form.setAttribute('action', next);
  }, true);
  for (const name of ['pushState', 'replaceState']) {
    const native = history[name];
    history[name] = function(state, title, url) {
      if (url != null) url = shareUrl(url);
      return native.call(this, state, title, url);
    };
  }
  try {
    const nativeOpen = window.open;
    window.open = function(url, target, features) {
      return nativeOpen.call(window, shareUrl(url), target, features);
    };
  } catch {}
  try {
    const nativeAssign = Location.prototype.assign;
    const nativeReplace = Location.prototype.replace;
    Location.prototype.assign = function(url) { return nativeAssign.call(this, shareUrl(url)); };
    Location.prototype.replace = function(url) { return nativeReplace.call(this, shareUrl(url)); };
  } catch {}
})();
</script>`;
}

function injectSharedNavigationPatch(html, shareId, targetOrigin) {
  if (String(html).includes('data-clonyfy-share-nav')) return html;
  const patch = sharedNavigationPatch(shareId, targetOrigin);
  if (html.includes('</body>')) return html.replace('</body>', `${patch}</body>`);
  return html + patch;
}

function rewriteSharedNavigationUrls(html, shareId, targetOrigin = '') {
  const shareBase = `/share/${shareId}`;
  const cleanTargetOrigin = String(targetOrigin || '').replace(/\/$/, '');
  const rewrite = (raw) => {
    if (!raw) return raw;
    if (/^#/i.test(raw)) return raw;
    if (/^(?:mailto|tel|sms|javascript|data|blob):/i.test(raw)) return raw;
    if (raw.startsWith('/api/') || raw.startsWith('/_assets/') || raw.startsWith('/share/')) return raw;
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/)/i.test(raw)) {
      try {
        const u = new URL(raw, cleanTargetOrigin || undefined);
        if (cleanTargetOrigin && u.origin === cleanTargetOrigin) return `${shareBase}${u.pathname}${u.search}${u.hash}`;
      } catch {}
      return raw;
    }

    if (raw === '/') return `${shareBase}/`;
    if (raw.startsWith('/#')) return `${shareBase}/${raw.slice(1)}`;
    if (raw.startsWith('/')) return `${shareBase}${raw}`;
    return `${shareBase}/${raw.replace(/^\.?\//, '')}`;
  };
  const rewritten = String(html).replace(/\b(href|action)=("([^"]*)"|'([^']*)')/gi, (match, attr, quoted, dbl, sgl) => {
    const value = dbl ?? sgl ?? '';
    const next = rewrite(value);
    if (next === value) return match;
    const quote = quoted.startsWith("'") ? "'" : '"';
    return `${attr}=${quote}${next}${quote}`;
  });
  return injectSharedNavigationPatch(rewritten, shareId, cleanTargetOrigin);
}

function routeFilename(route) {
  if (route === '/') return '__home__.html';
  return `${route.replace(/^\/+/, '').replace(/[^a-z0-9]+/gi, '_') || 'page'}.html`;
}

function authPageHtml(siteName, kind) {
  const isRegister = kind === 'register';
  const title = isRegister ? 'Create account' : 'Sign in';
  const subtitle = isRegister ? `Start using ${siteName}` : `Welcome back to ${siteName}`;
  const altHref = isRegister ? '/login' : '/register';
  const altText = isRegister ? 'Already have an account? Sign in' : 'Need an account? Register';
  const fields = isRegister
    ? '<label>Full name<input name="name" autocomplete="name" placeholder="Jane Doe" required></label>'
    : '';
  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${htmlEsc(title)} | ${htmlEsc(siteName)}</title>
<style>*{box-sizing:border-box}body{margin:0;min-height:100vh;font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;background:#f5f7fb;color:#111827;display:grid;place-items:center;padding:24px}.auth-shell{width:min(100%,420px);background:#fff;border:1px solid #e5e7eb;border-radius:8px;box-shadow:0 18px 55px rgba(15,23,42,.12);padding:32px}.brand{font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#2563eb;margin-bottom:22px}h1{font-size:30px;line-height:1.1;margin:0 0 8px}p{margin:0 0 24px;color:#6b7280;line-height:1.6}form{display:grid;gap:14px}label{display:grid;gap:7px;font-size:13px;font-weight:700;color:#374151}input{height:44px;border:1px solid #d1d5db;border-radius:6px;padding:0 12px;font:inherit;color:#111827;background:#fff}input:focus{outline:3px solid rgba(37,99,235,.16);border-color:#2563eb}button{height:46px;border:0;border-radius:6px;background:#2563eb;color:#fff;font:inherit;font-weight:800;cursor:pointer;margin-top:4px}button:hover{background:#1d4ed8}.alt{display:block;margin-top:18px;color:#2563eb;text-decoration:none;font-size:14px;font-weight:700}.fine{font-size:12px;color:#9ca3af;margin-top:18px;margin-bottom:0}</style>
</head><body><main class="auth-shell"><div class="brand">${htmlEsc(siteName)}</div><h1>${htmlEsc(title)}</h1><p>${htmlEsc(subtitle)}</p><form>${fields}<label>Email<input type="email" name="email" autocomplete="email" placeholder="you@example.com" required></label><label>Password<input type="password" name="password" autocomplete="${isRegister ? 'new-password' : 'current-password'}" placeholder="********" required></label><button type="submit">${htmlEsc(title)}</button></form><a class="alt" href="${altHref}">${htmlEsc(altText)}</a><p class="fine">This generated auth page is ready to connect to your real backend.</p></main></body></html>`;
}

function writeAuthPage(outDir, kind) {
  const map = loadRouteMap(outDir);
  if (!map) throw new Error('No generated site found');
  const route = kind === 'register' ? '/register' : '/login';
  const filename = map[route] || routeFilename(route);
  const pagesDir = join(outDir, 'captured-pages');
  const htmlPath = join(pagesDir, filename);
  if (!isInsideOutputDir(htmlPath)) throw new Error('Invalid page path');
  mkdirSync(pagesDir, { recursive: true });
  writeFileSync(htmlPath, authPageHtml(outDir.split(/[\\/]/).pop() || 'site', kind), 'utf8');
  map[route] = filename;
  writeFileSync(join(outDir, 'route-map.json'), JSON.stringify(map, null, 2), 'utf8');
  return { route, filename };
}

function readJsonBody(req, limitBytes = 100_000) {
  return new Promise((resolveBody, reject) => {
    let body = '';
    let size = 0;
    let tooLarge = false;
    req.on('data', (c) => {
      size += Buffer.byteLength(c);
      if (size > limitBytes) { tooLarge = true; req.resume(); return; }
      body += c;
    });
    req.on('end', () => {
      if (tooLarge) return reject(new Error('request too large'));
      try { resolveBody(JSON.parse(body || '{}')); }
      catch { reject(new Error('bad json')); }
    });
    req.on('error', reject);
  });
}

function readRawBody(req, limitBytes = 2_000_000) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > limitBytes) { req.destroy(); reject(new Error('too large')); return; }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function extensionForAsset(filename, mimeType) {
  const ext = String(filename || '').match(/\.[a-z0-9]{1,8}$/i)?.[0];
  const safeExts = new Set(['.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg', '.css', '.woff', '.woff2', '.ttf', '.mp4', '.webm', '.avif']);
  if (ext && safeExts.has(ext.toLowerCase())) return ext.toLowerCase();
  const mime = String(mimeType || '').toLowerCase();
  if (mime.includes('png')) return '.png';
  if (mime.includes('jpeg') || mime.includes('jpg')) return '.jpg';
  if (mime.includes('webp')) return '.webp';
  if (mime.includes('gif')) return '.gif';
  if (mime.includes('svg')) return '.svg';
  if (mime.includes('css')) return '.css';
  if (mime.includes('woff2')) return '.woff2';
  if (mime.includes('woff')) return '.woff';
  if (mime.includes('mp4')) return '.mp4';
  if (mime.includes('webm')) return '.webm';
  if (mime.includes('avif')) return '.avif';
  return '.bin';
}

function isAllowedImportedAssetMime(mimeType) {
  return /^(image\/(png|jpeg|webp|gif|svg\+xml|avif)|text\/css|font\/(woff|woff2|ttf)|video\/(mp4|webm))$/i.test(String(mimeType || ''));
}

let _outputsCache = null;
let _outputsCacheAt = 0;
function getOutputs(maxAgeMs = 2000) {
  const now = Date.now();
  if (_outputsCache && now - _outputsCacheAt < maxAgeMs) return _outputsCache;
  if (!existsSync(OUTPUT_DIR)) { _outputsCache = []; _outputsCacheAt = now; return []; }
  _outputsCache = readdirSync(OUTPUT_DIR)
    .map((name) => {
      const dir = join(OUTPUT_DIR, name);
      try {
        const stat = statSync(dir);
        if (!stat.isDirectory()) return null;
        const manifestPath = join(dir, 'manifest.json');
        const manifest = existsSync(manifestPath) ? JSON.parse(readFileSync(manifestPath, 'utf8')) : null;
        return { name, dir, targetOrigin: manifest?.targetOrigin ?? '', capturedAt: manifest?.capturedAt ?? stat.mtime.toISOString() };
      } catch { return null; }
    })
    .filter(Boolean)
    .sort((a, b) => b.capturedAt.localeCompare(a.capturedAt));
  _outputsCacheAt = now;
  return _outputsCache;
}
function invalidateOutputsCache() { _outputsCache = null; }

function sharePasswordFormHtml(shareId, error, actionPath) {
  const formAction = actionPath && actionPath.startsWith(`/share/${shareId}`) ? actionPath : `/share/${shareId}`;
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Protected Preview</title><style>*{box-sizing:border-box}body{margin:0;min-height:100vh;background:#07071a;font-family:Inter,system-ui,sans-serif;display:flex;align-items:center;justify-content:center;color:#e8e8ff}.card{background:#0c0c1c;border:1px solid rgba(255,255,255,.08);border-radius:18px;padding:40px 36px;width:min(400px,92vw)}.logo{width:150px;height:auto;display:block;margin-bottom:28px}.kicker{font-size:11px;font-weight:700;color:rgba(255,255,255,.28);letter-spacing:.08em;text-transform:uppercase;margin-bottom:10px}h2{font-size:22px;font-weight:800;margin:0 0 6px;letter-spacing:-.4px}p{margin:0 0 24px;color:rgba(255,255,255,.3);font-size:13px}.err{color:#e05070;font-size:12px;background:rgba(255,69,96,.07);border:1px solid rgba(255,69,96,.15);border-radius:8px;padding:10px 14px;margin-bottom:14px}input{width:100%;background:rgba(255,255,255,.04);border:1px solid rgba(255,255,255,.1);border-radius:10px;color:#e8e8ff;font-size:14px;padding:12px 16px;outline:none;font-family:inherit;margin-bottom:14px}input:focus{border-color:rgba(91,141,239,.45)}button{width:100%;padding:13px;background:linear-gradient(135deg,#5b8def,#a855f7);color:#fff;border:none;border-radius:10px;font-size:14px;font-weight:700;cursor:pointer;font-family:inherit}</style></head><body><div class="card"><img class="logo" src="/clonyfy-logo.png" alt="CLONYFY"><div class="kicker">Protected preview</div><h2>Password required</h2><p>This preview is password protected.</p>${error ? `<div class="err">${htmlEsc(error)}</div>` : ''}<form method="post" action="${htmlEsc(formAction)}"><input type="password" name="pw" placeholder="Enter password" autofocus required><button type="submit">View Preview</button></form></div></body></html>`;
}

function userPublic(u) {
  const plan = normalizePlan(u.plan);
  const limits = getEffectivePlanLimits(plan);
  return {
    id: u.id, name: u.name, email: u.email,
    plan,
    rawPlan: u.plan || 'free',
    planLabel: getPlanLabel(plan),
    planLimits: {
      clonesPerMonth: finiteLimit(limits.clonesPerMonth),
      maxPages: limits.maxPages,
      fullSiteAllowed: !!limits.fullSiteAllowed,
      fullSiteMaxPages: limits.fullSiteMaxPages,
      fullSiteDepth: limits.fullSiteDepth,
      editsPerMonth: finiteLimit(limits.editsPerMonth),
      savesPerMonth: finiteLimit(limits.savesPerMonth),
      sharesPerMonth: finiteLimit(limits.sharesPerMonth),
    },
    planRenewsAt: u.plan_renews_at || null,
    billingInterval: u.billing_interval || 'monthly',
    emailVerified: u.email_verified === 1 || u.email_verified === true,
    cancelAtPeriodEnd: u.cancel_at_period_end === 1,
    createdAt: u.created_at,
  };
}

// ── Request handler ────────────────────────────────────────────────────────────

// Returns true if the given outDir was created by (and belongs to) this user.
// Checks both in-memory running jobs and persisted DB clones so newly-started
// jobs (not yet written to the DB) still pass the ownership check.
async function userOwnsOutDir(user, outDir) {
  if (!outDir) return false;
  for (const job of jobs.values()) {
    if (job.userId === user.id && sameCloneOutDir(job.outDir, outDir)) return true;
  }
  const clones = await getClonesByUser(user.id);
  return clones.some(c => sameCloneOutDir(c.out_dir, outDir));
}

async function canReadOutDir(user, outDir) {
  if (!outDir) return false;
  if (user) return userOwnsOutDir(user, outDir);
  for (const job of jobs.values()) {
    if (job.userId === null && sameCloneOutDir(job.outDir, outDir)) return true;
  }
  const clone = await getCloneByOutDir(outDir).catch(() => null);
  if (clone && clone.user_id == null) return true;
  return false;
}

async function canReadCloneRecord(user, outDir) {
  if (!outDir) return false;
  let clone = await getCloneByOutDir(outDir).catch(() => null);
  if (!clone) {
    const clones = user
      ? await getClonesByUser(user.id).catch(() => [])
      : await getAllClones().catch(() => []);
    clone = (clones || []).find(c => sameCloneOutDir(c.out_dir, outDir)) || null;
  }
  if (!clone) return false;
  if (!clone.user_id) return true;
  return !!user && (clone.user_id === user.id || user.role === 'admin');
}

async function canUseCloneOutput(user, outDir) {
  if (!user || !outDir) return false;
  if (await userOwnsOutDir(user, outDir)) return true;
  return canReadCloneRecord(user, outDir);
}

function netlifyAPIRequest(method, path, token, body, contentType) {
  return new Promise((resolve, reject) => {
    const isBuffer = Buffer.isBuffer(body);
    const opts = {
      hostname: 'api.netlify.com', port: 443, path, method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': contentType,
        'Content-Length': isBuffer ? body.length : Buffer.byteLength(body),
      },
    };
    const req = httpsRequest(opts, (r) => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        try { resolve({ status: r.statusCode, body: JSON.parse(Buffer.concat(chunks).toString()) }); }
        catch { resolve({ status: r.statusCode, body: {} }); }
      });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function runProcess(file, args, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    const p = spawn(file, args, { stdio: 'ignore', ...opts });
    p.on('error', reject);
    p.on('close', code => code === 0 ? resolvePromise() : reject(new Error(`${file} exited ${code}`)));
  });
}

function routeToStaticPath(route) {
  const cleanRoute = String(route || '/').split('?')[0].split('#')[0];
  if (cleanRoute === '/' || !cleanRoute.replace(/\//g, '')) return 'index.html';
  const parts = cleanRoute
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .map(part => part.trim())
    .filter(Boolean)
    .filter(part => part !== '.' && part !== '..')
    .map(part => part.replace(/[<>:"\\|?*\x00-\x1F]/g, '-'))
    .filter(Boolean);
  const last = parts[parts.length - 1] || '';
  if (/\.[a-z0-9]{1,8}$/i.test(last)) return join(...parts);
  return join(...parts, 'index.html');
}

function copyDirRecursive(src, dest) {
  if (!existsSync(src)) return;
  mkdirSync(dest, { recursive: true });
  for (const entry of readdirSync(src, { withFileTypes: true })) {
    const srcPath = join(src, entry.name);
    const destPath = join(dest, entry.name);
    if (entry.isDirectory()) copyDirRecursive(srcPath, destPath);
    else if (entry.isFile()) copyFileSync(srcPath, destPath);
  }
}

async function materializeStaticWebsite(outDir) {
  const materialized = await materializeCloneOutput(outDir);
  const siteDir = join(OUTPUT_DIR, `__static_${randomUUID().slice(0, 8)}`);
  mkdirSync(siteDir, { recursive: true });
  try {
    const routeMapPath = join(materialized.dir, 'route-map.json');
    const capturedPagesDir = join(materialized.dir, 'captured-pages');
    const routeMap = existsSync(routeMapPath) ? JSON.parse(readFileSync(routeMapPath, 'utf8')) : null;
    if (routeMap && existsSync(capturedPagesDir)) {
      for (const [route, filename] of Object.entries(routeMap)) {
        let cleanFilename;
        try { cleanFilename = normalizeCloneRelPath(join('captured-pages', String(filename)), ['captured-pages']).slice('captured-pages/'.length); }
        catch { continue; }
        const srcPath = join(capturedPagesDir, cleanFilename);
        if (!existsSync(srcPath)) continue;
        const destPath = join(siteDir, routeToStaticPath(route));
        if (!isInsideDir(siteDir, destPath)) continue;
        mkdirSync(dirname(destPath), { recursive: true });
        copyFileSync(srcPath, destPath);
      }
    } else if (existsSync(capturedPagesDir)) {
      for (const file of readdirSync(capturedPagesDir)) {
        if (!file.endsWith('.html') || file.includes('..')) continue;
        const destName = file === '__root__.html' ? 'index.html' : file;
        copyFileSync(join(capturedPagesDir, file), join(siteDir, destName));
      }
    }
    copyDirRecursive(join(materialized.dir, 'public', '_assets'), join(siteDir, '_assets'));
    if (!existsSync(join(siteDir, 'index.html'))) {
      const firstHtml = readdirSync(siteDir, { recursive: true }).find(name => String(name).endsWith('.html'));
      if (firstHtml) copyFileSync(join(siteDir, String(firstHtml)), join(siteDir, 'index.html'));
    }
    return {
      dir: siteDir,
      cleanup: () => {
        try { materialized.cleanup(); } catch {}
        try { rmSync(siteDir, { recursive: true, force: true }); } catch {}
      },
    };
  } catch (err) {
    try { materialized.cleanup(); } catch {}
    try { rmSync(siteDir, { recursive: true, force: true }); } catch {}
    throw err;
  }
}

// Cross-platform ZIP creation. We previously shelled out to `tar -a` / `zip` /
// PowerShell, which produced inconsistent results: on some Linux runtimes
// (incl. some Linux containers) `tar -a -c -f x.zip` writes a TAR archive named
// `.zip` — the file lacks the PKZIP magic header (PK\x03\x04), so macOS
// Archive Utility refuses to open it. archiver is a pure-JS streaming
// implementation that always writes real PKZIP, identical on Mac/Linux/
// Windows and Linux hosts, so every user's OS unzips it without complaint.
async function createCrossPlatformZip(srcDir, zipPath, { skipDirs = [] } = {}) {
  if (!srcDir || !existsSync(srcDir)) throw new Error('ZIP source folder is missing');
  const { default: archiver } = await import('archiver');
  let fileCount = 0;
  await new Promise((resolvePromise, reject) => {
    const output = createWriteStream(zipPath);
    // level 6 is much faster than 9 on large asset trees and still compresses well
    const archive = archiver('zip', { zlib: { level: 6 } });
    let settled = false;
    const fail = (err) => { if (!settled) { settled = true; reject(err); } };
    output.on('close', () => {
      if (settled) return;
      settled = true;
      try {
        const size = existsSync(zipPath) ? statSync(zipPath).size : 0;
        if (fileCount === 0 || size < 64) {
          reject(new Error('ZIP archive is empty — no clone files were packed'));
          return;
        }
        resolvePromise();
      } catch (err) {
        reject(err);
      }
    });
    output.on('error', fail);
    archive.on('error', fail);
    archive.on('warning', (err) => { if (err.code !== 'ENOENT') fail(err); });
    archive.pipe(output);
    if (skipDirs.length) {
      const walk = (dir, prefix = '') => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            if (skipDirs.includes(entry.name)) continue;
            walk(join(dir, entry.name), prefix ? `${prefix}/${entry.name}` : entry.name);
          } else if (entry.isFile()) {
            const name = prefix ? `${prefix}/${entry.name}` : entry.name;
            archive.file(join(dir, entry.name), { name });
            fileCount++;
          }
        }
      };
      walk(srcDir);
    } else {
      archive.directory(srcDir, false);
      // directory() doesn't expose a count up front — approximate via walk
      const countWalk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) countWalk(join(dir, entry.name));
          else if (entry.isFile()) fileCount++;
        }
      };
      countWalk(srcDir);
    }
    if (fileCount === 0) {
      fail(new Error('ZIP source folder has no files'));
      return;
    }
    archive.finalize();
  });
}

function assertValidZipFile(zipPath) {
  if (!existsSync(zipPath)) throw new Error('ZIP was not created');
  const size = statSync(zipPath).size;
  if (size < 64) throw new Error('ZIP is empty — export failed. Open Run Preview, then try Export Code again.');
  const fd = openSync(zipPath, 'r');
  try {
    const magic = Buffer.alloc(4);
    const n = readSync(fd, magic, 0, 4, 0);
    if (n < 2 || magic[0] !== 0x50 || magic[1] !== 0x4b) {
      throw new Error('Export produced an invalid ZIP file');
    }
  } finally {
    closeSync(fd);
  }
  return size;
}

async function buildOutputZip(outDir) {
  if (!isInsideOutputDir(outDir)) throw new Error('Invalid output folder');
  ensureOutputDir();
  const materialized = await materializeCloneOutput(outDir);
  const zipName = `${outDir.split(/[\\/]/).pop()}.zip`;
  const zipPath = join(tmpdir(), `clonyfy-export-${randomUUID()}.zip`);
  try { rmSync(zipPath, { force: true }); } catch {}
  try {
    if (!cloneOutputHasPages(materialized.dir)) {
      throw new Error('Clone has no captured pages to export. Open Run Preview first.');
    }
    // Rebuild Next scaffolding when possible; on low-memory Free hosts this can OOM —
    // fall back to zipping captured HTML so export still succeeds.
    try {
      await regenerateCloneProject(materialized.dir);
    } catch (regenErr) {
      console.warn(`[export-zip] regenerateCloneProject failed, exporting captured pages only: ${regenErr?.message || regenErr}`);
      if (!cloneOutputHasPages(materialized.dir)) {
        throw new Error('Export regeneration failed and no captured pages remain. Re-run the clone, then export again.');
      }
    }
    if (!cloneOutputHasPages(materialized.dir)) {
      throw new Error('Export regeneration cleared page HTML. Re-run the clone, then export again.');
    }
    await createCrossPlatformZip(materialized.dir, zipPath, {
      skipDirs: ['node_modules', '.next', '.git'],
    });
    assertValidZipFile(zipPath);
  } finally {
    materialized.cleanup();
  }
  return { zipName, zipPath };
}

function githubAPIRequest(method, path, token, body = null) {
  return new Promise((resolvePromise, reject) => {
    const payload = body == null ? null : Buffer.from(JSON.stringify(body));
    const headers = {
      'Authorization': `Bearer ${token}`,
      'Accept': 'application/vnd.github+json',
      'User-Agent': 'clonyfy',
      'X-GitHub-Api-Version': '2022-11-28',
    };
    if (payload) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = payload.length;
    }
    const req = httpsRequest({ hostname: 'api.github.com', port: 443, path, method, headers }, (r) => {
      const chunks = [];
      r.on('data', c => chunks.push(c));
      r.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let parsed = {};
        try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { message: text }; }
        if (r.statusCode >= 200 && r.statusCode < 300) {
          resolvePromise({ status: r.statusCode, body: parsed });
        } else {
          const detail = parsed.message || `GitHub API HTTP ${r.statusCode}`;
          const err = new Error(detail);
          err.statusCode = r.statusCode;
          err.github = parsed;
          err.githubMethod = method;
          err.githubPath = path;
          reject(err);
        }
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function parseGitHubRepo(input) {
  const raw = String(input || '').trim();
  let match = raw.match(/^https?:\/\/github\.com\/([^/]+)\/([^/#?]+?)(?:\.git)?(?:[/?#].*)?$/i);
  if (!match) match = raw.match(/^([^/\s]+)\/([^/\s]+)$/);
  if (!match) return null;
  const owner = match[1];
  const repo = match[2].replace(/\.git$/i, '');
  if (!/^[A-Za-z0-9_.-]+$/.test(owner) || !/^[A-Za-z0-9_.-]+$/.test(repo)) return null;
  return { owner, repo };
}

function cleanGitPath(input) {
  const cleaned = String(input || '')
    .replace(/\\/g, '/')
    .replace(/^\/+|\/+$/g, '')
    .split('/')
    .filter(Boolean);
  if (cleaned.some(part => part === '.' || part === '..')) throw new Error('Invalid GitHub path');
  return cleaned.join('/');
}

function normalizeTargetUrl(input) {
  let raw = String(input || '').trim();
  if (!raw) throw new Error('Enter a website URL');
  if (/^https?:\/\/https?:[/:\\]?/i.test(raw)) throw new Error('Enter one valid website URL');
  raw = raw.replace(/\\/g, '/').replace(/^https?:\/(?!\/)/i, m => m.toLowerCase() + '/');
  if (!/^https?:\/\//i.test(raw)) raw = 'https://' + raw.replace(/^\/+/, '');
  const parsed = new URL(raw);
  if (!['http:', 'https:'].includes(parsed.protocol)) throw new Error('Use an http or https URL');
  if (!parsed.hostname || !parsed.hostname.includes('.') || ['http', 'https'].includes(parsed.hostname.toLowerCase()) || /[/:]/.test(parsed.hostname)) {
    throw new Error('Enter a valid website domain');
  }
  parsed.hash = '';
  return parsed;
}

// ── SSRF protection ──────────────────────────────────────────────────────────
// Block clone targets that resolve to private, loopback, link-local (incl. the
// 169.254.169.254 cloud-metadata endpoint) or other reserved address space, and
// obvious internal hostnames. Prevents using the cloner to reach internal
// services or steal cloud credentials.
function isPrivateIp(ip) {
  if (!ip) return true;
  ip = String(ip).toLowerCase().trim();
  if (ip.includes(':')) {
    if (ip === '::1' || ip === '::') return true;                 // loopback / unspecified
    if (ip.startsWith('fe80') || ip.startsWith('fc') || ip.startsWith('fd')) return true; // link-local / unique-local
    const mapped = ip.match(/(?:::ffff:)(\d+\.\d+\.\d+\.\d+)$/);  // IPv4-mapped IPv6
    if (mapped) return isPrivateIp(mapped[1]);
    return false;                                                 // global IPv6
  }
  const parts = ip.split('.').map(Number);
  if (parts.length !== 4 || parts.some(p => Number.isNaN(p) || p < 0 || p > 255)) return true; // malformed → block
  const [a, b] = parts;
  if (a === 0 || a === 10 || a === 127) return true;              // this-network / 10/8 / loopback
  if (a === 169 && b === 254) return true;                        // link-local incl. 169.254.169.254 metadata
  if (a === 172 && b >= 16 && b <= 31) return true;               // 172.16/12
  if (a === 192 && b === 168) return true;                        // 192.168/16
  if (a === 100 && b >= 64 && b <= 127) return true;              // CGNAT 100.64/10
  if (a === 192 && b === 0) return true;                          // 192.0.0/24 + 192.0.2/24 (test)
  if (a >= 224) return true;                                      // multicast / reserved
  return false;
}
function isBlockedHostname(host) {
  host = String(host || '').toLowerCase().replace(/\.$/, '');
  if (!host) return true;
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (['.local', '.internal', '.lan', '.home', '.intranet', '.corp'].some(s => host.endsWith(s))) return true;
  if (host === 'metadata.google.internal' || host === 'metadata') return true;
  return false;
}
async function assertPublicTarget(parsedUrl) {
  const rawHost = parsedUrl.hostname.replace(/^\[|\]$/g, ''); // strip IPv6 brackets
  if (isBlockedHostname(parsedUrl.hostname)) throw new Error('That address is not allowed');
  const looksLikeIp = /^[0-9.]+$/.test(rawHost) || rawHost.includes(':');
  if (looksLikeIp) {
    if (isPrivateIp(rawHost)) throw new Error('That address is not allowed');
    return; // public IP literal — fine
  }
  // Best-effort DNS check: block domains that resolve into private/reserved
  // space, but FAIL OPEN on resolver errors. The serverless DNS resolver can be
  // flaky or stricter than the cloner's own fetch resolver, and we must not
  // reject real sites it can otherwise reach. The genuine SSRF vectors —
  // IP-literal private addresses and internal hostnames — are already
  // hard-blocked above, so failing open here is safe.
  try {
    // Cap the lookup at 2.5s — dns/promises lookup has no built-in timeout, and
    // a slow/hung resolver on serverless would otherwise stall (and time out)
    // the whole clone request. On timeout we fail open (resolve null).
    const addrs = await Promise.race([
      dnsLookup(rawHost, { all: true }),
      new Promise((r) => setTimeout(() => r(null), 2500)),
    ]);
    for (const { address } of (addrs || [])) {
      if (isPrivateIp(address)) throw new Error('That address is not allowed');
    }
  } catch (err) {
    if (err && err.message === 'That address is not allowed') throw err; // preserve our own block
    // DNS error (ENOTFOUND / timeout / SERVFAIL): allow — the cloner will fail
    // gracefully on a genuinely unreachable domain instead of us false-blocking.
  }
}

function listOutputFiles(outDir) {
  const files = [];
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (['node_modules', '.next', '.git'].includes(entry.name)) continue;
        walk(abs);
      } else if (entry.isFile()) {
        const rel = relative(outDir, abs).replace(/\\/g, '/');
        files.push({ abs, rel, size: statSync(abs).size });
      }
    }
  };
  walk(outDir);
  return files;
}

function githubErrorStatus(err) {
  const msg = String(err?.message || '');
  if (/bad credentials|requires authentication|unauthorized/i.test(msg)) return 401;
  if (/git repository is empty/i.test(msg)) return 409;
  if (/not found/i.test(msg)) return 404;
  if (/validation failed|invalid|name already exists/i.test(msg)) return 400;
  if (/rate limit/i.test(msg)) return 429;
  return 502;
}

function isGitHubEmptyRepoError(err) {
  const msg = String(err?.message || err || '');
  const status = Number(err?.statusCode) || 0;
  return status === 409 || /git repository is empty|no commit found|repository is empty/i.test(msg);
}

function friendlyGitHubError(err) {
  const msg = String(err?.message || err || 'GitHub request failed');
  const status = Number(err?.statusCode) || 0;
  const ghPath = String(err?.githubPath || '');
  // Clone/storage errors often contain "not found" — check before GitHub repo messaging.
  if (/Output folder not found|could not be loaded|Clone pages could not be loaded|Invalid output folder/i.test(msg)) {
    return 'Clone files are missing from storage. Re-run the clone, then push again.';
  }
  if (/bad credentials|requires authentication|unauthorized/i.test(msg)) {
    return 'GitHub rejected the token. Create a PAT with repo scope (classic) or Contents: Read and write (fine-grained).';
  }
  if (isGitHubEmptyRepoError(err)) {
    return 'Could not initialize the empty GitHub repo. Open the repo on GitHub, add a README (commit), then push again — or recreate the repo with “Add a README” checked.';
  }
  if (/rate limit/i.test(msg)) {
    return 'GitHub API rate limit hit. Wait a minute and try again.';
  }
  if (/sha wasn.?t supplied|already exists/i.test(msg)) {
    return 'GitHub repo already has commits — retry push (initialization step is not needed).';
  }
  // Only blame "repo missing" when the failing call was GET/POST /repos/:owner/:repo itself.
  const isRepoLookup = /\/repos\/[^/]+\/[^/]+\/?(\?|$)/.test(ghPath) || /\/user\/repos\/?$/.test(ghPath);
  if ((status === 404 || /not found/i.test(msg)) && isRepoLookup) {
    return 'GitHub repository not found (or this token cannot access it). Create the empty repo on GitHub first, or check owner/repo spelling and PAT access.';
  }
  if (status === 404 || /not found/i.test(msg)) {
    const where = ghPath ? ` (${err.githubMethod || 'GET'} ${ghPath})` : '';
    return `GitHub API returned Not Found${where}. The repo is reachable, but this push step failed — try again; if it keeps failing, re-run the clone then push.`;
  }
  const ghErrors = Array.isArray(err?.github?.errors) ? err.github.errors.map((e) => e.message || e.code).filter(Boolean).join('; ') : '';
  return ghErrors ? `${msg} (${ghErrors})` : msg;
}

async function ensureGitHubRepo(token, owner, repoName) {
  try {
    return await githubAPIRequest('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`, token);
  } catch (err) {
    const msg = String(err?.message || '');
    if (!/not found/i.test(msg)) throw err;
    // Create an empty public repo under the authenticated user when possible.
    const me = await githubAPIRequest('GET', '/user', token);
    const login = String(me.body?.login || '').toLowerCase();
    if (!login || login !== String(owner).toLowerCase()) {
      throw new Error(
        `Repository ${owner}/${repoName} was not found. Create it on GitHub first (this token can only auto-create repos under ${me.body?.login || 'your user'}).`,
      );
    }
    const created = await githubAPIRequest('POST', '/user/repos', token, {
      name: repoName,
      private: false,
      auto_init: true,
      description: 'Imported from Clonyfy',
    });
    return created;
  }
}

/**
 * True when the repo has never been pushed to (manual empty create, no README).
 * Do NOT use `size === 0` alone — GitHub often leaves size at 0 after the first commits.
 */
function isGitHubRepoEmpty(repoInfo) {
  const body = repoInfo?.body || repoInfo || {};
  return body.pushed_at == null;
}

/**
 * Empty repos cannot use Git Data refs until they have at least one commit.
 * Contents API reliably creates the first commit + default branch.
 */
async function bootstrapEmptyGitHubRepo(token, owner, repoName, branch) {
  const content = Buffer.from(
    '# Clonyfy\n\nThis repository was initialized so Clonyfy can push clone files.\n',
    'utf8',
  ).toString('base64');
  const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/contents/.clonyfy-init.md`;
  // Already initialized (e.g. prior push or README) — nothing to do.
  try {
    await githubAPIRequest('GET', `${path}?ref=${encodeURIComponent(branch)}`, token);
    return;
  } catch (probeErr) {
    if (!/not found/i.test(String(probeErr?.message || '')) && Number(probeErr?.statusCode) !== 404) {
      // Repo may still be empty (409) — continue to create.
      if (!isGitHubEmptyRepoError(probeErr)) {
        try {
          await githubAPIRequest('GET', path, token);
          return;
        } catch {
          /* create below */
        }
      }
    }
  }
  const payload = {
    message: 'Initialize repository for Clonyfy',
    content,
  };
  // Prefer requested branch; if GitHub rejects it on a brand-new empty repo, retry without branch.
  try {
    await githubAPIRequest('PUT', path, token, { ...payload, branch });
  } catch (err) {
    const m = String(err?.message || '');
    if (/already exists|sha wasn.?t supplied/i.test(m)) return;
    if (isGitHubEmptyRepoError(err) || /branch .* not found/i.test(m) || Number(err?.statusCode) === 404) {
      try {
        await githubAPIRequest('PUT', path, token, payload);
      } catch (err2) {
        if (/already exists|sha wasn.?t supplied/i.test(String(err2?.message || ''))) return;
        throw err2;
      }
    } else {
      throw err;
    }
  }
  // Give GitHub a moment to materialize the default branch ref.
  for (let i = 0; i < 6; i++) {
    try {
      await githubAPIRequest(
        'GET',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/git/ref/heads/${encodeURIComponent(branch)}`,
        token,
      );
      return;
    } catch {
      const def = 'main';
      if (branch !== def) {
        try {
          await githubAPIRequest(
            'GET',
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/git/ref/heads/${encodeURIComponent(def)}`,
            token,
          );
          return;
        } catch {}
      }
      await new Promise((r) => setTimeout(r, 400 * (i + 1)));
    }
  }
}

async function githubUploadBlobsLimited(files, owner, repoName, token, prefix, concurrency = 4) {
  const entries = [];
  const nextPaths = new Set();
  let index = 0;
  const workers = Array.from({ length: Math.min(concurrency, Math.max(1, files.length)) }, async () => {
    while (index < files.length) {
      const i = index++;
      const file = files[i];
      const gitPath = prefix ? `${prefix}/${file.rel}` : file.rel;
      nextPaths.add(gitPath);
      let lastErr;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          const blob = await githubAPIRequest('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/git/blobs`, token, {
            content: readFileSync(file.abs).toString('base64'),
            encoding: 'base64',
          });
          entries[i] = { path: gitPath, mode: '100644', type: 'blob', sha: blob.body.sha };
          lastErr = null;
          break;
        } catch (err) {
          lastErr = err;
          const status = Number(err?.statusCode) || 0;
          if (status === 401 || status === 403 || status === 422) throw err;
          await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
        }
      }
      if (lastErr) {
        lastErr.message = `Failed uploading ${gitPath}: ${lastErr.message}`;
        throw lastErr;
      }
    }
  });
  await Promise.all(workers);
  return { entries: entries.filter(Boolean), nextPaths };
}

// Allowed origins for CORS. The app's own origin is always allowed.
// Stripe webhook calls have no Origin header and bypass this check.
function originsFromEnvValue(raw) {
  const out = new Set();
  const value = String(raw || '').trim();
  if (!value) return out;
  try {
    const url = new URL(value.includes('://') ? value : `https://${value}`);
    out.add(url.origin);
    const host = url.hostname;
    if (host.startsWith('www.')) {
      out.add(`${url.protocol}//${host.slice(4)}`);
    } else if (host.includes('.') && host !== 'localhost' && !/^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      out.add(`${url.protocol}//www.${host}`);
    }
  } catch {
    /* ignore invalid */
  }
  return out;
}

function isAllowedOrigin(origin) {
  if (!origin) return true; // same-origin / server-to-server requests have no Origin
  const allowed = new Set();
  try {
    const appUrl = String(getCachedSettings()?.app_url || DEFAULT_APP_URL);
    for (const o of originsFromEnvValue(appUrl)) allowed.add(o);
  } catch {}
  for (const raw of [
    process.env.FRONTEND_URL,
    process.env.PUBLIC_APP_URL,
    process.env.CORS_ORIGINS,
  ]) {
    for (const part of String(raw || '').split(',')) {
      for (const o of originsFromEnvValue(part.trim())) allowed.add(o);
    }
  }
  if (allowed.has(origin)) return true;
  // Allow localhost in development
  if (/^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin)) return true;
  // Vercel preview / production aliases
  if (/^https:\/\/[a-z0-9-]+-?[a-z0-9]*\.vercel\.app$/i.test(origin)) return true;
  return false;
}

function contentSecurityPolicyForPath(pathname) {
  const isPreviewSurface = pathname === '/api/page' || pathname === '/api/share-page' || pathname.startsWith('/share/') || pathname === '/api/asset' || pathname.startsWith('/_assets/');
  const frameAncestors = (() => {
    const allowed = new Set(["'self'"]);
    for (const raw of [process.env.FRONTEND_URL, process.env.PUBLIC_APP_URL, process.env.CORS_ORIGINS]) {
      for (const part of String(raw || '').split(',')) {
        for (const o of originsFromEnvValue(part.trim())) allowed.add(o);
      }
    }
    allowed.add('http://localhost:8080');
    allowed.add('http://127.0.0.1:8080');
    return [...allowed].join(' ');
  })();
  if (isPreviewSurface) {
    return [
      "default-src 'self'",
      "script-src 'self' 'unsafe-inline' 'unsafe-eval' https: blob:",
      "style-src 'self' 'unsafe-inline' fonts.googleapis.com https:",
      "font-src 'self' fonts.gstatic.com data: https:",
      "img-src 'self' data: blob: https:",
      "connect-src 'self' https: wss:",
      "frame-src 'self' https: blob: data: about:",
      `frame-ancestors ${frameAncestors}`,
      "worker-src 'self' blob:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      // Cloned site JS runs inside /api/page or /api/share-page (iframe), same as
      // the authenticated preview — not on the bare /share/ wrapper shell.
    ].join('; ');
  }
  return [
    "default-src 'self'",
    "script-src 'self' 'unsafe-inline' https://cdn.affonso.io",
    "style-src 'self' 'unsafe-inline' fonts.googleapis.com",
    "font-src 'self' fonts.gstatic.com data:",
    "img-src 'self' data: blob: https:",
    "connect-src 'self' https: wss:",
    "frame-src 'self'",
    "frame-ancestors 'none'",
    "worker-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join('; ');
}

/** Normalize request URL (supports legacy rewrite query/header if present). */
function parseRequestUrl(req) {
  const hostHeader = req.headers['x-forwarded-host'] || req.headers.host || `localhost:${PORT}`;
  const host = String(hostHeader).split(',')[0].trim();
  const proto = req.headers['x-forwarded-proto'] || 'http';
  const base = `${proto}://${host}`;
  const url = new URL(req.url || '/', base);

  if (url.pathname === '/api/index' || url.pathname === '/api') {
    const fromQuery = url.searchParams.get('__clonyfy_path');
    if (fromQuery !== null) {
      url.pathname = fromQuery ? `/${fromQuery.replace(/^\/+/, '')}` : '/';
      url.searchParams.delete('__clonyfy_path');
      return url;
    }
    const fromHeader = req.headers['x-invoke-path'] || req.headers['x-original-url'];
    if (typeof fromHeader === 'string' && fromHeader.startsWith('/')) {
      return new URL(fromHeader, base);
    }
  }

  return url;
}

async function handleRequest(req, res) {
  const url = parseRequestUrl(req);
  const ip = req.socket?.remoteAddress || req.headers['x-forwarded-for']?.split(',')[0] || 'unknown';
  const reqOrigin = req.headers['origin'] || '';

  // CORS — only allow our own origin, not arbitrary third-party sites
  if (reqOrigin) {
    if (isAllowedOrigin(reqOrigin)) {
      res.setHeader('Access-Control-Allow-Origin', reqOrigin);
      res.setHeader('Vary', 'Origin');
    }
    // If origin is not allowed, we omit the CORS header — browser will block the request
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Auth-Token, X-CLONYFY-Token, X-Admin-Token');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const isEmbeddablePreview =
    url.pathname === '/api/page' ||
    url.pathname === '/api/share-page' ||
    url.pathname === '/api/asset' ||
    url.pathname.startsWith('/share/') ||
    url.pathname.startsWith('/_assets/');
  // Cross-origin Frontend (Vercel) embeds /api/page in an iframe — SAMEORIGIN would blank it.
  if (!isEmbeddablePreview) {
    res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  }
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Permissions-Policy', 'geolocation=(), microphone=(), camera=()');
  // HSTS only when the request actually arrived over HTTPS (Render/proxy
  // terminates TLS and sets x-forwarded-proto) — never on plain-HTTP local dev.
  if (req.headers['x-forwarded-proto'] === 'https') {
    res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  }
  res.setHeader('Content-Security-Policy', contentSecurityPolicyForPath(url.pathname));
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // Product UI lives in the separate Frontend app. This server is API + cloner only.
  const isPageRead = req.method === 'GET' || req.method === 'HEAD';
  const UI_MOVED = {
    error: 'UI moved',
    message: 'This Backend serves API and clone tooling only. Use the Frontend app for the product UI.',
  };
  const uiPagePaths = new Set([
    '/', '/app', '/app/', '/index.html', '/dashboard', '/affiliate',
    '/reset-password', '/tos', '/privacy', '/login', '/register', '/admin',
  ]);
  if (isPageRead && uiPagePaths.has(url.pathname)) {
    return json(res, UI_MOVED, 410);
  }
  if (req.method === 'GET' && (url.pathname === '/favicon.ico' || url.pathname === '/favicon.png')) {
    return json(res, UI_MOVED, 404);
  }
  if (req.method === 'GET' && url.pathname.startsWith('/media/')) {
    const outDir = await previewOutDirFromReferer(req);
    if (outDir) {
      const { map, targetOrigin } = await buildPreviewAssetContext(outDir);
      const nextMediaPath = '/_next/static' + url.pathname;
      const mapped = map[nextMediaPath + url.search] || map[nextMediaPath];
      if (mapped) {
        res.writeHead(302, { Location: mapped, 'Cache-Control': 'public, max-age=3600' });
        res.end();
        return;
      }
      if (targetOrigin) {
        res.writeHead(302, { Location: targetOrigin + nextMediaPath + url.search, 'Cache-Control': 'public, max-age=3600' });
        res.end();
        return;
      }
    }
  }
  // Former Backend/public static UI assets were removed; clone assets use /_assets/ and /api/page.
  if (req.method === 'GET' && url.pathname.startsWith('/_assets/')) {
    let relPath;
    try { relPath = normalizeCloneRelPath(url.pathname.replace(/^\//, ''), ['_assets']); }
    catch { return json(res, { error: 'Invalid asset' }, 400); }
    const mimeMap = {
      '.css': 'text/css', '.js': 'application/javascript', '.png': 'image/png', '.ico': 'image/x-icon',
      '.svg': 'image/svg+xml', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
      '.webp': 'image/webp', '.woff': 'font/woff', '.woff2': 'font/woff2', '.ttf': 'font/ttf',
      '.eot': 'application/vnd.ms-fontobject', '.mp4': 'video/mp4', '.webm': 'video/webm', '.avif': 'image/avif',
    };
    const assetExt = relPath.match(/\.\w+$/)?.[0]?.toLowerCase();
    const type = mimeMap[assetExt] || 'application/octet-stream';
    const serveCloneAssetBytes = async (outDir, data) => {
      let contentType = type;
      if (contentType === 'application/octet-stream' && data.length) {
        const head = data.slice(0, 256).toString('utf8');
        if (/^\s*(\/\*|\/\/|!function|var |let |const |function |import |export |\(function|window\.|document\.|;|\(|\{)/.test(head)) {
          contentType = 'application/javascript';
        } else if (/^\s*([.#@a-zA-Z][^{]*\{|@(media|import|font-face|keyframes|charset))/.test(head)) {
          contentType = 'text/css';
        } else if (head.startsWith('<')) {
          contentType = 'text/html; charset=utf-8';
        }
      }
      if (contentType.startsWith('text/css')) {
        const css = await rewritePreviewCssAsset(data.toString('utf8'), outDir, relPath).catch(() => data.toString('utf8'));
        res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' });
        res.end(css);
        return true;
      }
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' });
      res.end(data);
      return true;
    };
    const refOutDir = await previewOutDirFromReferer(req);
    if (refOutDir && isInsideOutputDir(refOutDir)) {
      const stored = await readCloneFile(refOutDir, join('public', relPath));
      if (stored && await serveCloneAssetBytes(refOutDir, stored)) return;
    }
    const dirsToTry = getOutputs().map(o => o.dir);
    for (const dir of dirsToTry) {
      if (!dir) continue;
      const assetPath = join(dir, 'public', relPath);
      if (isInsideOutputDir(assetPath) && existsSync(assetPath)) return serveFile(res, assetPath, type, 3600);
    }
    res.writeHead(404); res.end(); return;
  }

  if (req.method === 'GET' && url.pathname === '/api/asset') {
    const assetUser = await getSessionUser(req);
    const outDir = resolveCloneOutDir(url.searchParams.get('outDir') || '');
    let relPath;
    try { relPath = normalizeCloneRelPath(url.searchParams.get('path') || '', ['_assets', 'public/_assets']); }
    catch { return json(res, { error: 'Invalid asset' }, 400); }
    const assetToken = String(url.searchParams.get('assetToken') || '');
    if (!outDir) return json(res, { error: 'Invalid asset' }, 400);
    let readable = await canReadOutDir(assetUser, outDir) || cloneAssetTokenMatches(outDir, assetToken);
    if (!readable) {
      const shareId = String(url.searchParams.get('shareId') || '').replace(/[^a-z0-9]/gi, '');
      if (shareId) {
        const share = await getShare(shareId);
        if (share && sameCloneOutDir(share.out_dir, outDir)) readable = true;
      }
    }
    if (!readable) return json(res, { error: assetUser ? 'Not found' : 'Not authenticated' }, assetUser ? 404 : 401);
    const storageRel = assetStorageRel(relPath);
    if (!storageRel) return json(res, { error: 'Invalid asset' }, 400);
    const data = await readCloneFile(outDir, storageRel);
    if (!data) {
      // Asset wasn't captured (or upload failed). Try to recover by looking
      // up the original URL from manifest and redirecting the browser to it.
      try {
        const ctx = await buildPreviewAssetContext(outDir);
        const assetKey = storageRel.replace(/^public\//, '');
        const origUrl = ctx.originalByRelPath?.[assetKey] || ctx.originalByRelPath?.[storageRel];
        if (origUrl && /^https?:\/\//.test(origUrl)) {
          res.writeHead(302, { Location: origUrl, 'Cache-Control': 'public, max-age=300' });
          res.end();
          return;
        }
      } catch {}
      res.writeHead(404); res.end('Not found'); return;
    }
    let contentType = contentTypeForPath(storageRel.replace(/^public\/_assets\//, ''));
    // Sniff content for .bin / octet-stream — capture sometimes saves JS/CSS without proper extension
    if (contentType === 'application/octet-stream' && data.length) {
      const head = data.slice(0, 256).toString('utf8');
      if (/^\s*(\/\*|\/\/|!function|var |let |const |function |import |export |\(function|window\.|document\.|;|\(|\{)/.test(head)) {
        contentType = 'application/javascript';
      } else if (/^\s*([.#@a-zA-Z][^{]*\{|@(media|import|font-face|keyframes|charset))/.test(head)) {
        contentType = 'text/css';
      } else if (head.startsWith('<')) {
        contentType = 'text/html; charset=utf-8';
      }
    }
    if (contentType.startsWith('text/css')) {
      const css = await rewritePreviewCssAsset(data.toString('utf8'), outDir, storageRel.replace(/^public\//, '')).catch(() => data.toString('utf8'));
      res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' });
      res.end(css);
      return;
    }
    res.writeHead(200, { 'Content-Type': contentType, 'Cache-Control': 'public, max-age=3600' });
    res.end(data);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/outputs') {
    const user = await getSessionUser(req);
    if (!user) return json(res, { error: 'Not authenticated' }, 401);
    const fast = url.searchParams.get('fast') === '1';
    const limit = Math.max(1, Math.min(500, parseInt(url.searchParams.get('limit') || (fast ? '100' : '500'), 10) || (fast ? 100 : 500)));
    const userClones = await getClonesByUser(user.id, limit);
    const labelByDir = Object.fromEntries(userClones.filter(c => c.out_dir && c.label).map(c => [c.out_dir, c.label]));
    const localByDir = fast ? {} : Object.fromEntries(getOutputs().map(o => [o.dir, o]));
    const normalized = [];
    for (const c of userClones.filter(c => c.out_dir)) {
      let status = c.status;
      let pages = c.pages;
      const startedMs = Date.parse(String(c.started_at || '')) || 0;
      const ageMs = startedMs ? Date.now() - startedMs : 0;
      const liveJob = jobs.get(c.id);
      if (
        (status === 'running' || status === 'queued' || status === 'saving') &&
        (!liveJob || !isActiveJob(liveJob)) &&
        ageMs > 30 * 60 * 1000
      ) {
        status = 'error';
        updateCloneStatus({
          id: c.id,
          status: 'error',
          completedAt: new Date().toISOString(),
        }).catch(() => {});
      }
      if (!fast && (status === 'done' || status === 'error' || status === 'saving')) {
        try {
          const out = resolveCloneOutDir(c.out_dir) || c.out_dir;
          if (status === 'error') {
            // Sticky failure — never promote Failed → Complete because ephemeral disk still has HTML.
            if ((Number(pages) || 0) <= 0) {
              const recovered = await countClonePagesBestEffort(out);
              if (recovered > 0) pages = recovered;
            }
          } else {
            // Hosted: Complete only when Storage still has pages (disk disappears on restart).
            let readable = IS_HOSTED
              ? await verifyCloneReadableFromStorage(out)
              : await verifyCloneReadable(out);
            if (!readable.ok && !IS_HOSTED) {
              readable = await verifyCloneReadable(out);
            }
            // During the same uptime, allow local pages to keep a freshly finished clone usable
            // even if Storage list is briefly lagging — but never for prior DB errors.
            if (!readable.ok && IS_HOSTED && status === 'saving') {
              readable = await verifyCloneReadable(out);
            }
            if (readable.ok) {
              status = 'done';
              if (readable.pages > 0 && readable.pages !== pages) {
                pages = readable.pages;
                updateCloneStatus({ id: c.id, status: 'done', pages }).catch(() => {});
              }
            } else if (status === 'done' || status === 'saving') {
              const recovered = await countClonePagesBestEffort(out);
              if (recovered > 0 && !IS_HOSTED) {
                pages = recovered;
                status = 'done';
                updateCloneStatus({ id: c.id, status: 'done', pages: recovered }).catch(() => {});
              } else {
                status = 'error';
                updateCloneStatus({
                  id: c.id,
                  status: 'error',
                  pages: pages || recovered || 0,
                  completedAt: c.completed_at || new Date().toISOString(),
                }).catch(() => {});
              }
            }
          }
        } catch {
          /* keep stored metrics */
        }
      }
      normalized.push({
        id: c.id,
        name: c.out_dir.split(/[\\/]/).pop(),
        dir: resolveCloneOutDir(c.out_dir) || c.out_dir,
        targetOrigin: c.url,
        capturedAt: c.completed_at || c.started_at,
        ...(localByDir[c.out_dir] || localByDir[resolveCloneOutDir(c.out_dir)] || {}),
        // Prefer DB/recovered metrics over local folder metadata (local may omit pages).
        status,
        pages,
        assets: c.assets,
        apiRoutes: c.api_routes,
        label: labelByDir[c.out_dir] || null,
      });
    }
    return json(res, normalized);
  }
  if (req.method === 'GET' && url.pathname === '/api/jobs') {
    const user = await getSessionUser(req);
    if (!user) return json(res, { error: 'Not authenticated' }, 401);
    return json(res, [...jobs.values()].filter(j => j.userId === user.id));
  }

  // ── Auth ───────────────────────────────────────────────────────────────────

  if (req.method === 'POST' && url.pathname === '/api/auth/register') {
    if (!checkRateLimit(`reg:${ip}`, 5, 3600000)) return json(res, { error: 'Too many accounts created from this address. Try again later.' }, 429);
    const body = await readJsonBody(req);
    const { name, email, password } = body;
    if (!await verifyTurnstile(body.turnstileToken, ip)) {
      return json(res, { error: 'Please complete the human verification and try again.' }, 400);
    }
    const referralCode = cleanReferralCode(body.referral || body.via || '');
    if (!name || !email || !password) return json(res, { error: 'Name, email and password are required' }, 400);
    if (password.length < 8) return json(res, { error: 'Password must be at least 8 characters' }, 400);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return json(res, { error: 'Invalid email address' }, 400);
    if (await getUserByEmail(email.toLowerCase().trim())) return json(res, { error: 'An account with this email already exists' }, 409);
    const { hash, salt } = await hashPw(password);
    const user = {
      id: randomUUID(), name: name.trim(), email: email.toLowerCase().trim(),
      hash, salt, verifyToken: null, verifyExpiry: null,
      createdAt: new Date().toISOString(),
    };
    await insertUser(user);
    await updateUser(user.id, { email_verified: 1 });
    await saveAffiliateSlug(affiliateSlug(user), user.id);
    if (referralCode) {
      const ownerId = await getAffiliateOwnerBySlug(referralCode);
      if (ownerId && ownerId !== user.id) {
        await addAffiliateReferral(ownerId, {
          userId: user.id,
          name: user.name,
          email: user.email,
          status: 'Signed up',
          source: referralCode,
          createdAt: user.createdAt,
        });
      }
    }
    const token = randomUUID();
    await insertSession({ token, userId: user.id, createdAt: new Date().toISOString(), expiresAt: Date.now() + 30*24*60*60*1000, impersonatedBy: null });
    audit(user.id, user.name, 'register', null, ip);
    const freshUser = await getUserById(user.id);
    const usage = await getUserUsageSummary(freshUser);
    return json(res, { token, user: userPublic(freshUser), usage });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/login') {
    if (!checkRateLimit(`login:${ip}`, 10, 300000)) return json(res, { error: 'Too many login attempts. Try again in 5 minutes.' }, 429);
    const body = await readJsonBody(req);
    const { email, password, remember } = body;
    if (!await verifyTurnstile(body.turnstileToken, ip)) {
      return json(res, { error: 'Please complete the human verification and try again.' }, 400);
    }
    if (!email || !password) return json(res, { error: 'Email and password are required' }, 400);
    const user = await getUserByEmail(email.toLowerCase().trim());
    const ok = user ? await verifyPw(password, user) : false;
    if (!ok) return json(res, { error: 'Invalid email or password' }, 401);
    if (user.blocked) return await blockedUserResponse(res, user);
    if (bcrypt && user.hash && !user.hash.startsWith('$2b$') && !user.hash.startsWith('$2a$')) {
      await updateUser(user.id, { hash: await bcrypt.hash(password, 12), salt: null });
    }
    const token = randomUUID();
    const ttl = remember === false ? 2 * 60 * 60 * 1000 : 30 * 24 * 60 * 60 * 1000; // 2h or 30d
    await insertSession({ token, userId: user.id, createdAt: new Date().toISOString(), expiresAt: Date.now() + ttl, impersonatedBy: null });
    audit(user.id, user.name, 'login', null, ip);
    const usage = await getUserUsageSummary(user);
    return json(res, { token, user: userPublic(user), usage });
  }

  if (req.method === 'GET' && (url.pathname === '/api/health' || url.pathname === '/health')) {
    const mem = process.memoryUsage();
    return json(res, {
      ok: true,
      service: 'clonyfy-backend',
      uptimeSec: Math.round(process.uptime()),
      hosted: IS_HOSTED,
      lowMemory: IS_LOW_MEMORY,
      cloneConcurrency: CLONE_CONCURRENCY,
      memory: {
        rssMb: Math.round(mem.rss / 1024 / 1024),
        heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
      },
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/captcha-config') {
    // Public: returns the Turnstile sitekey if CAPTCHA is configured, else
    // empty. No secrets exposed (the secret stays on the server).
    return json(res, turnstileEnabled() ? { provider: 'turnstile', sitekey: turnstileSiteKey() } : { provider: null, sitekey: '' });
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/me') {
    const user = await getSessionUser(req);
    if (!user) return json(res, { error: 'Not authenticated' }, 401);
    if (user.blocked) return await blockedUserResponse(res, user);
    const usage = await getUserUsageSummary(user);
    return json(res, { user: userPublic(user), usage });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
    const cookieToken = String(req.headers.cookie || '')
      .split(';')
      .map(part => part.trim())
      .find(part => part.startsWith('wc_auth_token='))
      ?.slice('wc_auth_token='.length);
    const token = req.headers['x-auth-token'] || (cookieToken ? decodeURIComponent(cookieToken) : '');
    if (token) {
      const session = await getSession(token);
      const user = session ? await getUserById(session.user_id) : null;
      if (user) audit(user.id, user.name, 'logout', null, ip);
      await deleteSession(token);
      _invalidateSession(token);
    }
    return json(res, { ok: true });
  }

  // ── Templates ──────────────────────────────────────────────────────────────

  const TEMPLATES_META = {
    blank:      { name: 'Blank Page',      description: 'Start with a clean white canvas',                    category: 'Basic' },
    landing:    { name: 'SaaS Landing',    description: 'Product page with hero, features, pricing, and CTA', category: 'Marketing' },
    portfolio:  { name: 'Portfolio',       description: 'Showcase your work with a clean minimal design',     category: 'Personal' },
    blog:       { name: 'Blog',            description: 'Clean article layout with sidebar and newsletter',   category: 'Content' },
    business:   { name: 'Business',        description: 'Professional corporate site with services and team', category: 'Business' },
    restaurant: { name: 'Restaurant',      description: 'Elegant dining site with menu and reservations',     category: 'Food' },
    ecommerce:  { name: 'Online Store',    description: 'Product catalog with filters, cart, and promotions', category: 'Store' },
  };

  if (req.method === 'GET' && url.pathname === '/api/templates') {
    return json(res, Object.entries(TEMPLATES_META).map(([id, meta]) => ({ id, ...meta })));
  }

  if (req.method === 'POST' && url.pathname === '/api/create-from-template') {
    const templateUser = await getSessionUser(req);
    if (!templateUser) return json(res, { error: 'Not authenticated' }, 401);
    readJsonBody(req).then(async ({ templateId }) => {
      const safeId = String(templateId || '').replace(/[^a-z0-9-]/gi, '');
      if (!safeId || !TEMPLATES_META[safeId]) return json(res, { error: 'Template not found' }, 404);
      const templateFile = join(__dirname, 'templates', 'starter-pages', `${safeId}.html`);
      if (!existsSync(templateFile)) return json(res, { error: 'Template file missing' }, 404);
      const id = randomUUID();
      const outDir = join(OUTPUT_DIR, `builder-${safeId}-${id.slice(0, 6)}`);
      mkdirSync(join(outDir, 'captured-pages'), { recursive: true });
      mkdirSync(join(outDir, 'public', '_assets'), { recursive: true });
      writeFileSync(join(outDir, 'captured-pages', '__home__.html'), readFileSync(templateFile, 'utf8'), 'utf8');
      writeFileSync(join(outDir, 'route-map.json'), JSON.stringify({ '/': '__home__.html' }, null, 2), 'utf8');
      writeAuthPage(outDir, 'login');
      writeAuthPage(outDir, 'register');
      const now = new Date().toISOString();
      writeFileSync(join(outDir, 'manifest.json'), JSON.stringify({ targetOrigin: `builder:${safeId}`, capturedAt: now, pages: [] }, null, 2), 'utf8');
      await insertClone({ id, userId: templateUser.id, userName: templateUser.name, url: `builder:${safeId}`, outDir, status: 'done', pages: 1, assets: 0, apiRoutes: 0, startedAt: now, completedAt: now });
      try { await persistCloneOutput(outDir); } catch {}
      invalidateOutputsCache();
      json(res, { ok: true, outDir });
    }).catch(() => json(res, { error: 'bad json' }, 400));
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/pages') {
    const pagesUser = await getSessionUser(req);
    const outDir = resolveCloneOutDir(url.searchParams.get('outDir'));
    if (!outDir) return json(res, []);
    if (!await canReadOutDir(pagesUser, outDir) && !await canReadCloneRecord(pagesUser, outDir)) {
      return json(res, { error: pagesUser ? 'Not found' : 'Not authenticated' }, pagesUser ? 404 : 401);
    }
    const map = await loadRouteMapAsync(outDir) || await inferRouteMapFromCapturedPages(outDir);
    if (!map) return json(res, []);
    return json(res, Object.keys(map));
  }

  if (req.method === 'GET' && url.pathname === '/api/page') {
    const pageUser = await getSessionUser(req);
    const outDir = resolveCloneOutDir(url.searchParams.get('outDir'));
    if (!outDir) { res.writeHead(404); res.end('No clone specified'); return; }
    if (!await canReadOutDir(pageUser, outDir) && !await canReadCloneRecord(pageUser, outDir)) {
      if (!pageUser) return json(res, { error: 'Not authenticated' }, 401);
      res.writeHead(404); res.end('Not found'); return;
    }
    const route = url.searchParams.get('route') || '/';
    let map = await loadRouteMapAsync(outDir) || await inferRouteMapFromCapturedPages(outDir);
    if (!map) {
      // Hosted: local disk may be gone after restart — rematerialize from Storage once.
      try {
        const materialized = await materializeCloneOutput(outDir);
        map = loadRouteMap(materialized.dir) || await inferRouteMapFromCapturedPages(materialized.dir);
        if (materialized.dir !== outDir) {
          // Copy critical pages back into the canonical outDir when possible.
          try {
            if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });
            const pagesSrc = join(materialized.dir, 'captured-pages');
            const pagesDst = join(outDir, 'captured-pages');
            if (existsSync(pagesSrc)) {
              mkdirSync(pagesDst, { recursive: true });
              for (const name of readdirSync(pagesSrc)) {
                copyFileSync(join(pagesSrc, name), join(pagesDst, name));
              }
            }
            const rmSrc = join(materialized.dir, 'route-map.json');
            if (existsSync(rmSrc)) copyFileSync(rmSrc, join(outDir, 'route-map.json'));
            map = loadRouteMap(outDir) || map;
          } catch {}
          try { materialized.cleanup(); } catch {}
        }
      } catch (err) {
        console.warn('[api/page] rematerialize failed:', err?.message || err);
      }
    }
    if (!map) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('No clone loaded — output files are missing from disk and storage. Re-run the clone.');
      return;
    }
    const resolved = resolveSharedRoute(map, route, '/');
    if (!resolved.filename) {
      res.writeHead(404, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(cloneMissingRouteHtml(route, Object.keys(map)));
      return;
    }
    let data;
    try { data = await readCloneFile(outDir, join('captured-pages', resolved.filename)); }
    catch { return json(res, { error: 'Invalid page path' }, 400); }
    if (!data) { res.writeHead(404); res.end('File missing'); return; }
    const editorMode = url.searchParams.get('mode') === 'editor';
    let html = data.toString('utf8');
    if (editorMode) {
      html = neutralizeCloneScripts(html);
      const apiBase = apiPublicUrl(req).replace(/\/$/, '');
      html = await rewritePreviewAssetUrls(html, outDir, {
        injectPreviewNav: false,
        injectScrollReveal: false,
        baseHref: `${apiBase}/`,
      });
      // srcdoc resolves relative URLs against the Frontend origin — force API host.
      html = html.replace(/(["'(])\/api\/asset\?/g, `$1${apiBase}/api/asset?`);
      if (html.match(/<head[^>]*>/i)) {
        html = html.replace(/<head[^>]*>/i, (m) => `${m}<style id="clonyfy-editor-style">[contenteditable="true"]{outline:1px dashed rgba(91,141,239,.55);outline-offset:2px}img.clonyfy-edit-target{cursor:pointer;outline:2px solid transparent}img.clonyfy-edit-target:hover{outline-color:rgba(91,141,239,.7)}</style>`);
      }
      if (html.match(/<body\b/i)) {
        html = html.replace(/<body\b([^>]*)>/i, (m, attrs = '') => {
          if (/\bcontenteditable\s*=/i.test(attrs)) return m;
          return `<body${attrs} contenteditable="true">`;
        });
      }
    } else {
      html = await rewritePreviewAssetUrls(html, outDir);
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(html);
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/share-page') {
    const shareId = String(url.searchParams.get('shareId') || '').replace(/[^a-z0-9]/gi, '');
    const share = shareId ? await getShare(shareId) : null;
    if (!share) { res.writeHead(404); res.end('Share link not found'); return; }
    if (share.expires_at && Date.now() > share.expires_at) { res.writeHead(410); res.end('Share link expired'); return; }
    if (!hasShareAccess(req, share)) {
      res.writeHead(401, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end('<p style="font-family:system-ui;padding:40px">This share link is password protected. Open the share URL and enter the password first.</p>');
      return;
    }
    const route = url.searchParams.get('route') || '/';
    const loaded = await loadSharedPreviewHtml(share, shareId, route);
    if (loaded.error) { res.writeHead(loaded.status || 404); res.end(loaded.error); return; }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(loaded.html);
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/save-page') {
    const saveUser = await getSessionUser(req);
    if (!saveUser) return json(res, { error: 'Not authenticated' }, 401);
    // 50MB limit — cloned pages with inlined assets can be several MB
    readJsonBody(req, 50_000_000).then(async ({ outDir: rawOutDir, route, html }) => {
      const outDir = resolveCloneOutDir(rawOutDir);
      if (!outDir) return json(res, { error: 'Invalid output folder' }, 400);
      if (!await canUseCloneOutput(saveUser, outDir)) return json(res, { error: 'Not found' }, 404);
      const quota = await consumeUsageQuota(saveUser, 'save', { outDir, record: false });
      if (!quota.allowed) return json(res, { error: quota.error, usage: { kind: 'save', used: quota.used, limit: quota.limit } }, 429);
      const map = await loadRouteMapAsync(outDir) || await inferRouteMapFromCapturedPages(outDir);
      if (!map) return json(res, { error: 'No clone loaded' }, 404);
      const filename = map[route || '/'];
      if (!filename) return json(res, { error: 'Route not found: ' + route }, 404);
      await writeCloneFile(outDir, join('captured-pages', filename), sanitizeStoredCloneHtml(String(html ?? '')), 'text/html; charset=utf-8');
      const recorded = await consumeUsageQuota(saveUser, 'save', { outDir });
      json(res, { ok: true, usage: { kind: 'save', used: recorded.used, limit: recorded.limit } });
    }).catch(err => {
      if (res.headersSent) return;
      if (err?.message === 'request too large') return json(res, { error: 'Page HTML too large to save (limit 50MB)' }, 413);
      return json(res, { error: err?.message || 'Save failed' }, 500);
    });
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/create-auth-page') {
    const authPageUser = await getSessionUser(req);
    if (!authPageUser) return json(res, { error: 'Not authenticated' }, 401);
    readJsonBody(req).then(async ({ outDir: rawOutDir, kind }) => {
      const outDir = resolveCloneOutDir(rawOutDir);
      if (!outDir) return json(res, { error: 'Invalid output folder' }, 400);
      if (!await canUseCloneOutput(authPageUser, outDir)) return json(res, { error: 'Not found' }, 404);
      const pageKind = kind === 'register' ? 'register' : 'login';
      const map = await loadRouteMapAsync(outDir) || await inferRouteMapFromCapturedPages(outDir);
      if (!map) return json(res, { error: 'No clone loaded' }, 404);
      const route = pageKind === 'register' ? '/register' : '/login';
      const filename = routeFilename(route);
      map[route] = filename;
      const html = authPageHtml(outDir.split(/[\\/]/).pop() || 'site', pageKind);
      await writeCloneFile(outDir, join('captured-pages', filename), html, 'text/html; charset=utf-8');
      await writeCloneFile(outDir, 'route-map.json', JSON.stringify(map, null, 2), 'application/json');
      const page = { route, filename };
      json(res, { ok: true, ...page });
    }).catch((err) => json(res, { error: err instanceof Error ? err.message : 'bad json' }, 400));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/import-asset') {
    const assetUser = await getSessionUser(req);
    if (!assetUser) return json(res, { error: 'Not authenticated' }, 401);
    readJsonBody(req).then(async ({ outDir: rawOutDir, dataUrl, filename }) => {
      const outDir = resolveCloneOutDir(rawOutDir);
      if (!outDir) return json(res, { error: 'Invalid output folder' }, 400);
      if (!await canUseCloneOutput(assetUser, outDir)) return json(res, { error: 'Not found' }, 404);
      const match = String(dataUrl || '').match(/^data:([^;]+);base64,(.+)$/);
      if (!match) return json(res, { error: 'Invalid file data' }, 400);
      if (!isAllowedImportedAssetMime(match[1])) return json(res, { error: 'Unsupported asset type' }, 400);
      const bytes = Buffer.from(match[2], 'base64');
      if (bytes.length > 50 * 1024 * 1024) return json(res, { error: 'File is larger than 50MB' }, 400);
      const assetsDir = join(outDir, 'public', '_assets');
      if (!isInsideOutputDir(assetsDir)) return json(res, { error: 'Invalid asset path' }, 400);
      const assetName = `user-${randomUUID().slice(0, 8)}${extensionForAsset(filename, match[1])}`;
      await writeCloneFile(outDir, join('public', '_assets', assetName), bytes, match[1]);
      const relPath = `_assets/${assetName}`;
      const previewPath = `/api/asset?outDir=${encodeURIComponent(outDir)}&assetToken=${cloneAssetToken(outDir)}&path=${encodeURIComponent(relPath)}`;
      const publicBase = apiPublicUrl(req).replace(/\/$/, '');
      json(res, {
        ok: true,
        path: `/_assets/${assetName}`,
        previewUrl: `${publicBase}${previewPath}`,
        mimeType: match[1],
        size: bytes.length,
      });
    }).catch(() => json(res, { error: 'bad json' }, 400));
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/usage/consume') {
    const usageUser = await getSessionUser(req);
    if (!usageUser) return json(res, { error: 'Not authenticated' }, 401);
    if (usageUser.blocked) return await blockedUserResponse(res, usageUser);
    const { kind, outDir: rawOutDir } = await readJsonBody(req);
    if (!['edit', 'save', 'share'].includes(kind)) return json(res, { error: 'Invalid usage kind' }, 400);
    const outDir = rawOutDir ? resolveCloneOutDir(rawOutDir) : '';
    if (rawOutDir && !outDir) return json(res, { error: 'Invalid output folder' }, 400);
    if (outDir && !await canUseCloneOutput(usageUser, outDir)) return json(res, { error: 'Not found' }, 404);
    const quota = await consumeUsageQuota(usageUser, kind, { outDir });
    if (!quota.allowed) return json(res, { error: quota.error, usage: { kind, used: quota.used, limit: quota.limit } }, 429);
    return json(res, { ok: true, usage: { kind, used: quota.used, limit: quota.limit } });
  }

  if (req.method === 'GET' && url.pathname === '/api/usage') {
    const usageUser = await getSessionUser(req);
    if (!usageUser) return json(res, { error: 'Not authenticated' }, 401);
    if (usageUser.blocked) return await blockedUserResponse(res, usageUser);
    return json(res, await getUserUsageSummary(usageUser));
  }

  if (req.method === 'GET' && url.pathname === '/api/status') {
    const id = url.searchParams.get('id');
    const job = jobs.get(id) || await readPersistedJob(id);
    if (!job) return json(res, { error: 'not found' }, 404);
    const statusUser = await getSessionUser(req);
    const statusUserId = statusUser ? statusUser.id : null;
    if (job.userId !== statusUserId) return json(res, { error: 'not found' }, 404);
    const logsFrom = Math.max(0, parseInt(url.searchParams.get('logsFrom') || '0', 10) || 0);
    if (logsFrom > 0 && Array.isArray(job.logs)) {
      return json(res, { ...job, logs: job.logs.slice(logsFrom), logOffset: logsFrom });
    }
    return json(res, { ...job, logOffset: 0 });
  }

  // ── Clone ──────────────────────────────────────────────────────────────────

  if (req.method === 'POST' && url.pathname === '/api/clone') {
    const cloneUser = await getSessionUser(req);
    if (!cloneUser) return json(res, { error: 'Sign in to clone a website.' }, 401);
    if (cloneUser.blocked) return await blockedUserResponse(res, cloneUser);

    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', async () => {
      let parsed;
      try { parsed = JSON.parse(body); } catch { return json(res, { error: 'bad json' }, 400); }
      let target;
      try { target = normalizeTargetUrl(parsed.url); } catch (err) { return json(res, { error: err.message || 'Invalid URL' }, 400); }
      // SSRF guard: reject private/internal/metadata targets before cloning.
      // Only the explicit "not allowed" decision blocks a clone — any other
      // (transient/internal) error in the guard must NOT fail an otherwise-valid
      // clone, so legitimate sites never get blocked by a guard hiccup.
      try {
        await assertPublicTarget(target);
      } catch (err) {
        if (err && err.message === 'That address is not allowed') {
          return json(res, { error: 'That address is not allowed (private or internal hosts cannot be cloned).' }, 400);
        }
        // unexpected guard error — log and continue; the cloner will handle a bad URL.
        console.warn('[ssrf-guard] non-blocking error for', target.href, '-', err?.message || err);
      }
      const targetUrl = target.href;
      const { ignoreRobots = false } = parsed;
      const wantFullSite = !!(parsed.fullSite || parsed.selectAllPages);
      let depth = String(parsed.depth ?? '3');
      let maxPages = String(parsed.maxPages ?? '20');
      let fullSite = false;
      const requestedMaxPages = parseInt(maxPages, 10) || 20;

      if (cloneUser) {
        const plan = normalizePlan(cloneUser.plan);
        const limits = getEffectivePlanLimits(plan);
        if (limits.clonesPerMonth !== Infinity) {
          const used = await getCloneCountThisMonth(cloneUser.id, planPeriodStart(cloneUser).toISOString());
          if (used >= limits.clonesPerMonth) {
            return json(res, { error: `Monthly limit reached (${used}/${limits.clonesPerMonth} for ${plan} plan). Upgrade to clone more.` }, 429);
          }
        }
        // Per-user hourly burst limit: free=2/hr, paid=5/hr
        const hourlyMax = isPaidPlan(plan) ? 5 : 2;
        if (!checkRateLimit(`clone_user:${cloneUser.id}`, hourlyMax, 3600000)) {
          return json(res, { error: `Too many clone requests. Please wait before starting another.` }, 429);
        }
        // Cap concurrent running jobs per user
        const userRunning = [...jobs.values()].filter(j => j.userId === cloneUser.id && isActiveJob(j)).length;
        if (userRunning >= 2) {
          return json(res, { error: 'You already have 2 clones running. Wait for one to finish before starting another.' }, 429);
        }

        if (wantFullSite) {
          if (!limits.fullSiteAllowed) {
            return json(res, { error: 'Select all pages is available on the Scale plan. Upgrade to clone the full site.' }, 403);
          }
          fullSite = true;
          maxPages = String(limits.fullSiteMaxPages);
          depth = String(limits.fullSiteDepth);
        } else {
          maxPages = String(Math.min(parseInt(maxPages, 10) || 20, limits.maxPages));
        }
      } else if (wantFullSite) {
        return json(res, { error: 'Sign in with a Scale plan to use Select all pages.' }, 401);
      }
      maxPages = String(Math.max(1, parseInt(maxPages, 10) || 1));
      depth = String(Math.max(1, parseInt(depth, 10) || 1));

      const id = randomUUID();
      const hostname = target.hostname.replace(/\./g, '-');
      const outDir = resolve(OUTPUT_DIR, `${hostname}-${id.slice(0, 6)}`);

      // On tight ephemeral disks, wipe previous clone directories so the new
      // clone has enough space. Keep dirs belonging to currently-active jobs.
      if (IS_SERVERLESS) {
        const activeDirs = [...jobs.values()]
          .filter(j => isActiveJob(j) && j.outDir)
          .map(j => j.outDir);
        cleanupServerlessTemp([...activeDirs, outDir]);
      }

      const job = {
        id, url: targetUrl, hostname: target.hostname,
        status: 'running', logs: [], outDir,
        startedAt: new Date().toISOString(),
        pages: null, apiRoutes: null, assets: null,
        maxPages: parseInt(maxPages, 10), depth: parseInt(depth, 10) || 3, ignoreRobots: !!ignoreRobots,
        fullSite,
        userId: cloneUser ? cloneUser.id : null,
        userName: cloneUser ? cloneUser.name : 'Anonymous',
      };
      if (fullSite) {
        job.logs.push(`[INFO] Full-site mode: cloning same-origin pages under ${target.hostname} (budget ${job.maxPages} pages, depth ${job.depth}).`);
        if (IS_SERVERLESS) {
          job.logs.push(`[WARN] Full-site clones on serverless are time/disk limited. Prefer a dedicated Node host (Render) and set CLONYFY_FULL_SITE_MAX_PAGES.`);
        }
      } else if (IS_SERVERLESS && requestedMaxPages > job.maxPages) {
        job.logs.push(`[WARN] Page limit capped to ${job.maxPages} on serverless deployment. Set CLONYFY_SERVERLESS_MAX_PAGES or run on Render for larger clones.`);
      }
      jobs.set(id, job);
      persistJob(job, { force: true });
      const offloadQueue = IS_SERVERLESS
        ? createCloneOffloadQueue(outDir, (msg) => {
          job.logs.push(`[WARN] ${msg}`);
          persistJob(job);
        })
        : null;
      job.offloadQueue = offloadQueue;
      try {
        await insertClone({
          id: job.id, userId: job.userId, userName: job.userName,
          url: job.url, outDir: job.outDir, status: job.status,
          pages: job.pages, assets: job.assets, apiRoutes: job.apiRoutes,
          startedAt: job.startedAt, completedAt: null,
        });
      } catch (dbErr) {
        job.logs.push(`[WARN] Could not create initial clone record: ${dbErr?.message || dbErr}`);
        persistJob(job, { force: true });
      }

      if (cloneUser) audit(cloneUser.id, cloneUser.name, 'clone_start', targetUrl, ip);

      const args = ['clone', targetUrl, '--out', outDir, '--max-pages', String(maxPages), '--depth', String(depth), '--concurrency', String(CLONE_CONCURRENCY)];
      if (ignoreRobots) args.push('--ignore-robots');
      if (fullSite) args.push('--full-site');

      const finalizeCloneJob = async (code, signal = null) => {
        let exitCode = code;
        if (exitCode !== 0) {
          job.logs.push(`[ERROR] Clone process exited with code ${exitCode ?? 'null'}${signal ? ` signal ${signal}` : ''}`);
          // Salvage partial captures instead of discarding a long crawl with zero result.
          try {
            const salvaged = await countClonePagesBestEffort(outDir);
            if (salvaged > 0) {
              job.logs.push(`[WARN] Salvaging ${salvaged} captured page(s) after non-zero exit.`);
              exitCode = 0;
              if (job.pages == null || job.pages === 0) job.pages = salvaged;
            }
          } catch {}
        }
        job.status = exitCode === 0 ? 'saving' : 'error';
        persistJob(job, { force: true });
        if (exitCode === 0) { invalidateOutputsCache(); }
        const findNum = (pat) => {
          const line = job.logs.find((l) => l.includes(pat));
          if (!line) return null;
          const m = line.match(/:\s*(\d+)/);
          return m ? parseInt(m[1], 10) : null;
        };
        job.pages = findNum('Pages      :') ?? findNum('Pages       :') ?? findNum('Pages:') ?? job.pages ?? null;
        job.apiRoutes = findNum('API routes :') ?? findNum('API routes  :') ?? findNum('API routes:') ?? 0;
        job.assets = findNum('Total unique assets saved') ?? findNum('Assets      :') ?? findNum('Assets       :') ?? findNum('Assets:') ?? 0;
        if (job.pages === null || job.pages === 0) {
          try {
            const counted = await countClonePagesBestEffort(outDir);
            if (counted > 0) job.pages = counted;
            else if (job.pages === null) {
              const pagesDir = join(outDir, 'captured-pages');
              job.pages = existsSync(pagesDir)
                ? readdirSync(pagesDir).filter(f => f.endsWith('.html') && f !== '__login__.html' && f !== '__register__.html').length
                : 0;
            }
          } catch { if (job.pages === null) job.pages = 0; }
        }
        const completedAt = new Date().toISOString();
        let cloneReadable = exitCode !== 0 ? { ok: false, error: 'Clone process failed' } : null;
        if (exitCode === 0) {
          try {
            if (job.offloadQueue) await job.offloadQueue.flush();
            // Critical HTML first so preview works; asset upload continues in background on hosted.
            await persistCloneOutput(job.outDir, { deferAssets: IS_HOSTED, requireCritical: true });
            cloneReadable = await verifyCloneReadableWithRetry(job.outDir);
            if (!cloneReadable.ok) {
              await persistCloneOutput(job.outDir, { deferAssets: false, requireCritical: true });
              cloneReadable = await verifyCloneReadableWithRetry(job.outDir, 3);
            }
            // On Render/hosted, require Storage — local disk is ephemeral and will vanish on restart.
            if (IS_HOSTED && cloneReadable?.ok) {
              let stored = await verifyCloneReadableFromStorage(job.outDir);
              if (!stored.ok) {
                job.logs.push(`[WARN] Storage verify failed (${stored.error}) — re-uploading critical files`);
                await persistCloneOutput(job.outDir, { deferAssets: false, requireCritical: true });
                stored = await verifyCloneReadableFromStorage(job.outDir);
              }
              if (!stored.ok) {
                cloneReadable = { ok: false, error: stored.error || 'Clone pages were not saved to storage' };
                job.logs.push(`[ERROR] Clone finished on disk but Storage persist failed: ${cloneReadable.error}`);
              } else {
                cloneReadable = stored;
              }
            }
            if (cloneReadable?.ok && cloneReadable.pages > 0) {
              job.pages = cloneReadable.pages;
            } else if ((job.pages ?? 0) <= 0) {
              const recovered = await countClonePagesBestEffort(job.outDir);
              if (recovered > 0) {
                job.pages = recovered;
                // Hosted still requires storage — don't mark ok from disk-only recovery.
                if (!IS_HOSTED) cloneReadable = { ok: true, pages: recovered };
                else if (!cloneReadable?.ok) {
                  cloneReadable = { ok: false, error: 'Pages exist on disk but were not saved to durable storage' };
                }
              } else {
                cloneReadable = { ok: false, error: 'Clone captured 0 pages' };
              }
            }
            if (!cloneReadable.ok) {
              job.logs.push(`[ERROR] Clone output is not ready for preview: ${cloneReadable.error}`);
            }
            // On serverless: files are now in Supabase Storage, so free ephemeral disk
            // before the instance handles another clone.
            if (IS_SERVERLESS && cloneReadable?.ok) {
              try { rmSync(job.outDir, { recursive: true, force: true }); } catch {}
            }
          } catch (storageErr) {
            job.logs.push(`[ERROR] Could not persist clone files: ${storageErr?.message || storageErr}`);
            cloneReadable = { ok: false, error: storageErr?.message || String(storageErr) };
          }
        }
        let cloneRecordSaved = false;
        try {
          await insertClone({
            id: job.id, userId: job.userId, userName: job.userName,
            url: job.url, outDir: job.outDir, status: exitCode === 0 && cloneReadable?.ok ? 'done' : 'error',
            pages: job.pages, assets: job.assets, apiRoutes: job.apiRoutes,
            startedAt: job.startedAt, completedAt,
          });
          cloneRecordSaved = true;
        } catch (dbErr) {
          job.logs.push(`[WARN] Could not save clone record: ${dbErr?.message || dbErr}`);
        }
        const cloneSucceeded = exitCode === 0 && cloneReadable?.ok;
        if (exitCode === 0) {
          job.status = cloneSucceeded ? 'done' : 'error';
          if (!cloneRecordSaved && cloneReadable?.ok) {
            job.logs.push('[WARN] Clone finished, but history persistence failed. Preview and export may still work from local output.');
          }
        }
        persistJob(job, { force: true });
        if (!cloneSucceeded) {
          try {
            const errorLines = job.logs.filter(l => l.startsWith('[ERROR]') || l.toLowerCase().includes('error'));
            await insertError({
              id: job.id, userId: job.userId, userName: job.userName,
              url: job.url, errorSummary: errorLines[0] || job.logs[job.logs.length - 1] || 'Unknown error',
              logs: JSON.stringify(job.logs.slice(-100)),
              startedAt: job.startedAt, failedAt: completedAt,
            });
            await pruneErrors();
          } catch {}
        }
        if (cloneUser) {
          audit(cloneUser.id, cloneUser.name, cloneSucceeded ? 'clone_complete' : 'clone_error', `${targetUrl} pages=${job.pages}`, ip);
          if (cloneSucceeded) {
            checkUsageAlert(cloneUser.id);
            const s = getCachedSettings();
            const appUrl = (s.app_url || `http://localhost:${PORT}`).replace(/\/$/, '');
            sendEmail(cloneUser.email, `Clone complete — ${new URL(targetUrl).hostname}`,
              renderEmail('clone-complete', {
                SUBJECT: `Clone complete — ${new URL(targetUrl).hostname}`,
                NAME: cloneUser.name,
                SITE: new URL(targetUrl).hostname,
                PAGES: String(job.pages ?? 0),
                LINK: appUrl + '/app',
              })
            ).catch(() => {});
          }
        }
      };

      if (USE_INLINE_CLONE) {
        // Never block the HTTP response on the crawl — Frontend needs job.id immediately to poll.
        void (async () => {
          const deadlineTimer = setTimeout(() => {
            job.logs.push(`[WARN] Clone deadline (${Math.round(CLONE_DEADLINE_MS / 60000)} min) reached — stopping and salvaging captured pages.`);
            persistJob(job, { force: true });
          }, CLONE_DEADLINE_MS);
          try {
            const result = await Promise.race([
              runClone({
                url: targetUrl,
                out: outDir,
                maxPages: parseInt(maxPages, 10),
                depth: parseInt(depth, 10) || 3,
                concurrency: CLONE_CONCURRENCY,
                ignoreRobots: !!ignoreRobots,
                verbose: false,
                fullSite,
              }, {
                onLog: (line) => {
                  if (line) job.logs.push(line);
                  persistJob(job);
                },
                onArtifactWritten: offloadQueue
                  ? (event) => offloadQueue.offload(event)
                  : undefined,
              }),
              new Promise((_, reject) => {
                setTimeout(() => reject(new Error(`Clone deadline exceeded (${Math.round(CLONE_DEADLINE_MS / 60000)} min)`)), CLONE_DEADLINE_MS);
              }),
            ]);
            clearTimeout(deadlineTimer);
            if (offloadQueue) await offloadQueue.flush();
            job.pages = result.pages;
            job.assets = result.assets;
            job.apiRoutes = result.apiRoutes;
            await finalizeCloneJob(0);
          } catch (err) {
            clearTimeout(deadlineTimer);
            const msg = String(err?.message || err);
            job.logs.push(`[ERROR] ${msg}`);
            if (job.offloadQueue) {
              try { await job.offloadQueue.flush(); } catch {}
            }
            let salvageable = 0;
            try {
              const pagesDir = join(outDir, 'captured-pages');
              const routeMapPath = join(outDir, 'route-map.json');
              if (existsSync(routeMapPath)) {
                salvageable = existsSync(pagesDir)
                  ? readdirSync(pagesDir).filter(f => f.endsWith('.html')).length
                  : 0;
                if (salvageable === 0) {
                  const map = JSON.parse(readFileSync(routeMapPath, 'utf8'));
                  salvageable = Object.keys(map).length;
                }
              }
            } catch {}
            if (salvageable > 0) {
              const diskFull = /ENOSPC|no space left/i.test(msg);
              const deadline = /deadline/i.test(msg);
              job.logs.push(`[WARN] ${deadline ? 'Hit clone deadline' : diskFull ? 'Ran out of temporary storage during finalization' : 'Finalization failed'} — salvaging ${salvageable} captured page(s) so your clone is still usable.`);
              if (job.offloadQueue) await job.offloadQueue.flush();
              await finalizeCloneJob(0);
            } else {
              await finalizeCloneJob(1);
            }
          }
        })();
      } else {
        const childEnv = {
          ...process.env,
          ...(IS_HOSTED && !process.env.CLONYFY_FAST_CLONE ? { CLONYFY_FAST_CLONE: '1' } : {}),
        };
        const proc = spawn(process.execPath, [CLI, ...args], {
          cwd: __dirname,
          env: childEnv,
        });
        job.proc = proc;
        // While Chromium runs, periodically push captured HTML to Storage so a mid-clone
        // crash/restart still leaves a previewable salvage.
        const midPersistTimer = IS_HOSTED
          ? setInterval(() => {
            if (!isActiveJob(job) || !existsSync(outDir)) return;
            persistCloneOutput(outDir, { deferAssets: true, requireCritical: false }).catch((err) => {
              job.logs.push(`[WARN] Mid-clone storage sync: ${err?.message || err}`);
            });
          }, 25_000)
          : null;
        const deadlineTimer = setTimeout(() => {
          if (!isActiveJob(job)) return;
          job.logs.push(`[WARN] Clone deadline (${Math.round(CLONE_DEADLINE_MS / 60000)} min) reached — stopping crawl and salvaging pages.`);
          persistJob(job, { force: true });
          try { proc.kill('SIGTERM'); } catch {}
          setTimeout(() => { try { proc.kill('SIGKILL'); } catch {} }, 12_000);
        }, CLONE_DEADLINE_MS);
        proc.stdout.on('data', (c) => {
          c.toString().split('\n').filter(Boolean).forEach((l) => job.logs.push(l));
          persistJob(job);
        });
        proc.stderr.on('data', (c) => {
          c.toString().split('\n').filter(Boolean).forEach((l) => job.logs.push(`[ERROR] ${l}`));
          persistJob(job);
        });
        proc.on('close', (code, signal) => {
          clearTimeout(deadlineTimer);
          if (midPersistTimer) clearInterval(midPersistTimer);
          finalizeCloneJob(code, signal).catch((err) => {
            job.status = 'error';
            job.logs.push(`[ERROR] Could not finalize clone: ${err?.message || err}`);
            persistJob(job, { force: true });
          });
        });
      }

      return json(res, job);
    });
    return;
  }

  // ── Clone rename ─────────────────────────────────────────────────────────
  if (req.method === 'PATCH' && url.pathname.startsWith('/api/clones/')) {
    const renameUser = await getSessionUser(req);
    if (!renameUser) return json(res, { error: 'Not authenticated' }, 401);
    const cloneId = url.pathname.slice('/api/clones/'.length);
    const { label } = await readJsonBody(req);
    if (!cloneId) return json(res, { error: 'Missing id' }, 400);
    const job = jobs.get(cloneId);
    let owns = job ? (job.userId === renameUser.id || renameUser.role === 'admin') : false;
    if (!owns && !job) {
      const clones = await getClonesByUser(renameUser.id);
      owns = clones.some(c => c.id === cloneId) || renameUser.role === 'admin';
    }
    if (!owns) return json(res, { error: 'Not found' }, 404);
    const safe = String(label || '').trim().slice(0, 80);
    await updateCloneLabel({ id: cloneId, label: safe || null });
    if (job) job.label = safe || null;
    return json(res, { ok: true, label: safe || null });
  }

  // ── Preview / export / delete ─────────────────────────────────────────────

  if (req.method === 'POST' && url.pathname === '/api/preview') {
    const previewUser = await getSessionUser(req);
    if (!previewUser) return json(res, { error: 'Not authenticated' }, 401);
    const body = await readJsonBody(req);
    const outDir = resolveCloneOutDir(body?.outDir);
    if (!outDir) return json(res, { error: 'Invalid output folder' }, 400);
    if (!await canUseCloneOutput(previewUser, outDir)) return json(res, { error: 'Not found' }, 404);
    if (IS_HOSTED) {
      let map = await loadRouteMapAsync(outDir) || await inferRouteMapFromCapturedPages(outDir);
      if (!map) {
        try {
          const materialized = await materializeCloneOutput(outDir);
          map = loadRouteMap(materialized.dir) || await inferRouteMapFromCapturedPages(materialized.dir);
          try { materialized.cleanup(); } catch {}
        } catch (err) {
          console.warn('[api/preview] rematerialize failed:', err?.message || err);
        }
      }
      if (!map) {
        return json(res, {
          error: 'Preview pages not found. Files may not have been saved to storage — re-run the clone after redeploying the Backend.',
        }, 404);
      }
      const token = previewUser._sessionToken || '';
      const qs = new URLSearchParams({ outDir, route: '/' });
      if (token) qs.set('access_token', token);
      return json(res, {
        ok: true,
        url: `${apiPublicUrl(req)}/api/page?${qs.toString()}`,
        hosted: true,
      });
    }
    if (!existsSync(outDir)) return json(res, { error: 'Output folder not found' }, 404);
    try {
      const needsInstall = !existsSync(join(outDir, 'node_modules'));
      const cmd = needsInstall ? 'npm install && npm run dev' : 'npm run dev';
      const proc = spawn(cmd, [], { cwd: outDir, shell: true, detached: true, stdio: 'ignore' });
      proc.unref();
      return json(res, { ok: true, url: 'http://localhost:3000' });
    } catch(err) { return json(res, { error: err.message }, 500); }
  }

  if (req.method === 'POST' && url.pathname === '/api/export-zip') {
    const zipUser = await getSessionUser(req);
    if (!zipUser) return json(res, { error: 'Not authenticated' }, 401);
    if (!isPaidPlan(zipUser.plan)) return json(res, { error: 'Export requires a paid plan. Upgrade to download your clones.' }, 403);
    const body = await readJsonBody(req);
    const outDir = resolveCloneOutDir(body?.outDir);
    if (!outDir) return json(res, { error: 'Invalid output folder' }, 400);
    if (!await canUseCloneOutput(zipUser, outDir)) return json(res, { error: 'Not found' }, 404);
    try {
      const { zipName, zipPath } = await buildOutputZip(outDir);
      return json(res, { ok: true, zipPath, folder: OUTPUT_DIR });
    } catch(err) {
      const message = err?.message || 'ZIP export failed';
      if (/paid plan|Upgrade/i.test(message)) return json(res, { error: message }, 403);
      if (/no captured pages|No clone|missing/i.test(message)) return json(res, { error: message }, 404);
      if (/heap|ENOMEM|out of memory|killed/i.test(message)) {
        return json(res, { error: 'ZIP export ran out of memory. Re-try once, or upgrade Backend RAM.' }, 500);
      }
      return json(res, { error: message }, 500);
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/download-zip') {
    const dlUser = await getSessionUser(req);
    if (!dlUser) return json(res, { error: 'Not authenticated' }, 401);
    if (!isPaidPlan(dlUser.plan)) return json(res, { error: 'Export requires a paid plan. Upgrade to download your clones.' }, 403);
    const outDir = resolveCloneOutDir(url.searchParams.get('outDir') || '');
    if (!outDir) return json(res, { error: 'Invalid output folder' }, 400);
    if (!await canUseCloneOutput(dlUser, outDir)) return json(res, { error: 'Not found' }, 404);
    try {
      const { zipName, zipPath } = await buildOutputZip(outDir);
      const zipSize = assertValidZipFile(zipPath);
      // Large ZIPs leave via signed Storage URLs (single object or chunked parts).
      const LARGE_ZIP_BYTES = 32 * 1024 * 1024;
      if (IS_SERVERLESS || zipSize > LARGE_ZIP_BYTES) {
        if (zipSize > 500 * 1024 * 1024) {
          try { rmSync(zipPath, { force: true }); } catch {}
          return json(res, { error: 'Export ZIP is too large to deliver (>500MB). Lower max pages or contact support.' }, 413);
        }
        const storagePrefix = `exports/${dlUser.id}/${randomUUID().slice(0, 8)}`;
        let payload;
        try {
          payload = await uploadExportZipForDownload(storagePrefix, zipPath, zipName);
        } finally {
          try { rmSync(zipPath, { force: true }); } catch {}
        }
        audit(dlUser.id, dlUser.name, 'export_zip_signed', `outDir=${outDir} size=${zipSize} mode=${payload.mode}`, ip);
        return json(res, { ok: true, ...payload });
      }
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${zipName}"`,
        'Content-Length': zipSize,
        'Cache-Control': 'no-store',
      });
      const stream = createReadStream(zipPath);
      stream.pipe(res);
      stream.on('close', () => { try { rmSync(zipPath); } catch {} });
    } catch(err) {
      const message = err?.message || 'ZIP download failed';
      if (/heap|ENOMEM|out of memory|killed/i.test(message)) {
        return json(res, { error: 'ZIP export ran out of memory. Re-try once, or upgrade Backend RAM.' }, 500);
      }
      return json(res, { error: message }, 500);
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/figma/render') {
    const figmaUser = await getSessionUser(req);
    if (!figmaUser) return json(res, { error: 'Not authenticated' }, 401);
    if (!isPaidPlan(figmaUser.plan)) return json(res, { error: 'Figma export requires a paid plan. Upgrade to export designs.' }, 403);
    const { html, outDir: rawOutDir, viewportWidth: rawWidth, route, title } = await readJsonBody(req, 50_000_000);
    if (!html) return json(res, { error: 'No HTML provided' }, 400);
    const outDir = rawOutDir ? resolveCloneOutDir(rawOutDir) : '';
    const viewportWidth = Math.min(2560, Math.max(320, parseInt(rawWidth, 10) || 1440));
    try {
      let prepared = String(html);
      if (outDir && await canUseCloneOutput(figmaUser, outDir)) {
        prepared = await prepareHtmlForFigmaExport(prepared, outDir);
      }
      const svg = await htmlToFigmaSvg(prepared, {
        viewportWidth,
        title: title || route || 'Clonyfy export',
        readAsset: IS_HOSTED && outDir ? figmaAssetReader(outDir) : null,
      });
      audit(figmaUser.id, figmaUser.name, 'figma_render', `outDir=${outDir || ''} route=${route || ''}`, ip);
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Content-Disposition': `attachment; filename="${routeToSvgFilename(route || '/')}"`,
        'Cache-Control': 'no-store',
      });
      res.end(svg);
    } catch (err) {
      const msg = String(err?.message || err || 'Figma export failed');
      const oom = /heap|ENOMEM|out of memory|killed|ENOSPC/i.test(msg);
      return json(res, {
        error: oom
          ? 'Figma export ran out of memory on this host. Try a smaller page or upgrade Backend RAM.'
          : (msg || 'Figma export failed'),
      }, 500);
    }
    return;
  }

  // Step 3: Scene Graph JSON for the Clonyfy Figma plugin (clipboard import).
  if (req.method === 'POST' && url.pathname === '/api/figma/scene') {
    const figmaUser = await getSessionUser(req);
    if (!figmaUser) return json(res, { error: 'Not authenticated' }, 401);
    if (!isPaidPlan(figmaUser.plan)) return json(res, { error: 'Figma export requires a paid plan. Upgrade to export designs.' }, 403);
    const { html, svg, outDir: rawOutDir, viewportWidth: rawWidth, route, title } = await readJsonBody(req, 50_000_000);
    const outDir = rawOutDir ? resolveCloneOutDir(rawOutDir) : '';
    const viewportWidth = Math.min(2560, Math.max(320, parseInt(rawWidth, 10) || 1440));
    const sceneRoute = route || '/';
    const sceneTitle = title || sceneRoute || 'Clonyfy export';
    try {
      let scene;
      if (svg) {
        scene = svgToFigmaScene(String(svg), { name: sceneTitle, route: sceneRoute });
      } else if (html) {
        let prepared = String(html);
        if (outDir && await canUseCloneOutput(figmaUser, outDir)) {
          prepared = await prepareHtmlForFigmaExport(prepared, outDir);
        }
        scene = await htmlToFigmaScene(prepared, {
          viewportWidth,
          title: sceneTitle,
          route: sceneRoute,
          readAsset: IS_HOSTED && outDir ? figmaAssetReader(outDir) : null,
        });
      } else {
        return json(res, { error: 'Provide html or svg' }, 400);
      }
      audit(figmaUser.id, figmaUser.name, 'figma_scene', `outDir=${outDir || ''} route=${sceneRoute}`, ip);
      return respondWithFigmaScene(res, scene, figmaUser);
    } catch (err) {
      const msg = String(err?.message || err || 'Figma scene export failed');
      const oom = /heap|ENOMEM|out of memory|killed|ENOSPC/i.test(msg);
      return json(res, {
        error: oom
          ? 'Figma Desktop export ran out of memory on this host. Try a smaller page or upgrade Backend RAM.'
          : (msg || 'Figma scene export failed'),
      }, 500);
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/figma/scene') {
    const figmaUser = await getSessionUser(req);
    if (!figmaUser) return json(res, { error: 'Not authenticated' }, 401);
    if (!isPaidPlan(figmaUser.plan)) return json(res, { error: 'Figma export requires a paid plan. Upgrade to export designs.' }, 403);
    const outDir = resolveCloneOutDir(url.searchParams.get('outDir') || '');
    if (!outDir) return json(res, { error: 'Invalid output folder' }, 400);
    if (!await canUseCloneOutput(figmaUser, outDir)) return json(res, { error: 'Not found' }, 404);
    const route = url.searchParams.get('route') || '/';
    const viewportWidth = Math.min(1440, Math.max(320, parseInt(url.searchParams.get('width') || '1280', 10) || 1280));
    const deadlineMs = IS_LOW_MEMORY ? 75_000 : (IS_HOSTED ? 100_000 : 180_000);
    try {
      const map = await loadRouteMapAsync(outDir) || await inferRouteMapFromCapturedPages(outDir);
      if (!map) return json(res, { error: 'No pages found' }, 404);
      const filename = map[route] || map['/'];
      if (!filename) return json(res, { error: 'Route not found' }, 404);
      const data = await readCloneFile(outDir, capturedPageStorageRel(filename));
      if (!data) return json(res, { error: 'Page file missing — re-run the clone so files are saved to storage.' }, 404);
      const runExport = async () => {
        const html = await prepareHtmlForFigmaExport(data.toString('utf8'), outDir);
        return htmlToFigmaScene(html, {
          viewportWidth,
          title: route,
          route,
          readAsset: (IS_HOSTED || IS_SERVERLESS || IS_LOW_MEMORY) ? figmaAssetReader(outDir) : null,
        });
      };
      const scene = await Promise.race([
        runExport(),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error(
            'Figma Desktop scene timed out. Try again, or use Download SVG for Figma Web.',
          )), deadlineMs);
        }),
      ]);
      audit(figmaUser.id, figmaUser.name, 'figma_scene', `outDir=${outDir} route=${route}`, ip);
      return respondWithFigmaScene(res, scene, figmaUser);
    } catch (err) {
      const msg = String(err?.message || err || 'Figma scene export failed');
      const oom = /heap|ENOMEM|out of memory|killed|ENOSPC/i.test(msg);
      const timedOut = /timed out/i.test(msg);
      return json(res, {
        error: oom
          ? 'Figma Desktop export ran out of memory. Try Download SVG, or upgrade Backend RAM.'
          : timedOut
            ? msg
            : (msg || 'Figma scene export failed'),
      }, timedOut ? 504 : 500);
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/download-figma') {
    const figmaUser = await getSessionUser(req);
    if (!figmaUser) return json(res, { error: 'Not authenticated' }, 401);
    if (!isPaidPlan(figmaUser.plan)) return json(res, { error: 'Figma export requires a paid plan. Upgrade to export designs.' }, 403);
    const outDir = resolveCloneOutDir(url.searchParams.get('outDir') || '');
    if (!outDir) return json(res, { error: 'Invalid output folder' }, 400);
    if (!await canUseCloneOutput(figmaUser, outDir)) return json(res, { error: 'Not found' }, 404);
    const route = url.searchParams.get('route') || '/';
    const viewportWidth = Math.min(1440, Math.max(320, parseInt(url.searchParams.get('width') || '1280', 10) || 1280));
    const deadlineMs = IS_LOW_MEMORY ? 75_000 : (IS_HOSTED ? 100_000 : 180_000);
    try {
      const map = await loadRouteMapAsync(outDir) || await inferRouteMapFromCapturedPages(outDir);
      if (!map) return json(res, { error: 'No pages found' }, 404);
      const filename = map[route] || map['/'];
      if (!filename) return json(res, { error: 'Route not found' }, 404);
      const data = await readCloneFile(outDir, capturedPageStorageRel(filename));
      if (!data) return json(res, { error: 'Page file missing — re-run the clone so files are saved to storage.' }, 404);
      const runExport = async () => {
        const html = await prepareHtmlForFigmaExport(data.toString('utf8'), outDir);
        return htmlToFigmaSvg(html, {
          viewportWidth,
          title: route,
          readAsset: (IS_HOSTED || IS_SERVERLESS || IS_LOW_MEMORY) ? figmaAssetReader(outDir) : null,
        });
      };
      const svg = await Promise.race([
        runExport(),
        new Promise((_, reject) => {
          setTimeout(() => reject(new Error(
            'Figma SVG export timed out. Try Export for Figma Desktop, or a smaller page.',
          )), deadlineMs);
        }),
      ]);
      audit(figmaUser.id, figmaUser.name, 'figma_export', `outDir=${outDir} route=${route}`, ip);
      res.writeHead(200, {
        'Content-Type': 'image/svg+xml; charset=utf-8',
        'Content-Disposition': `attachment; filename="${routeToSvgFilename(route)}"`,
        'Cache-Control': 'no-store',
      });
      res.end(svg);
    } catch (err) {
      const msg = String(err?.message || err || 'Figma export failed');
      const oom = /heap|ENOMEM|out of memory|killed|ENOSPC/i.test(msg);
      const timedOut = /timed out/i.test(msg);
      return json(res, {
        error: oom
          ? 'Figma export ran out of memory on this host. Try Export for Figma Desktop, or upgrade Backend RAM.'
          : timedOut
            ? msg
            : (msg || 'Figma export failed'),
      }, timedOut ? 504 : 500);
    }
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/download-figma-zip') {
    const figmaUser = await getSessionUser(req);
    if (!figmaUser) return json(res, { error: 'Not authenticated' }, 401);
    if (!isPaidPlan(figmaUser.plan)) return json(res, { error: 'Figma export requires a paid plan. Upgrade to export designs.' }, 403);
    const outDir = resolveCloneOutDir(url.searchParams.get('outDir') || '');
    if (!outDir) return json(res, { error: 'Invalid output folder' }, 400);
    if (!await canUseCloneOutput(figmaUser, outDir)) return json(res, { error: 'Not found' }, 404);
    const viewportWidth = Math.min(2560, Math.max(320, parseInt(url.searchParams.get('width') || '1440', 10) || 1440));
    try {
      const map = await loadRouteMapAsync(outDir) || await inferRouteMapFromCapturedPages(outDir);
      if (!map) return json(res, { error: 'No pages found' }, 404);
      const allRoutes = Object.keys(map);
      const routeCap = IS_LOW_MEMORY ? 8 : (IS_SERVERLESS ? 12 : 80);
      const routes = allRoutes.slice(0, routeCap);
      const zipName = `${outDir.split(/[\\/]/).pop() || 'clone'}-figma.zip`;
      const zipPath = join(tmpdir(), `clonyfy-figma-${randomUUID()}.zip`);
      await exportCloneToFigmaZip({
        outDir,
        routes,
        rewriteHtml: async (raw, dir) => prepareHtmlForFigmaExport(String(raw), dir),
        readHtml: async (dir, route) => {
          const pageFile = map[route] || map['/'];
          const pageData = await readCloneFile(dir, capturedPageStorageRel(pageFile));
          if (!pageData) throw new Error(`Missing page file for ${route}`);
          return pageData.toString('utf8');
        },
        readAsset: IS_HOSTED ? figmaAssetReader(outDir) : null,
        viewportWidth,
        zipPath,
      });
      audit(figmaUser.id, figmaUser.name, 'figma_export_zip', `outDir=${outDir} pages=${routes.length}`, ip);
      if (!existsSync(zipPath)) return json(res, { error: 'Figma ZIP was not created' }, 500);
      res.writeHead(200, {
        'Content-Type': 'application/zip',
        'Content-Disposition': `attachment; filename="${zipName}"`,
        'Content-Length': statSync(zipPath).size,
        'Cache-Control': 'no-store',
      });
      const stream = createReadStream(zipPath);
      stream.pipe(res);
      stream.on('close', () => { try { rmSync(zipPath); } catch {} });
    } catch (err) {
      const msg = String(err?.message || err || 'Figma export failed');
      const oom = /heap|ENOMEM|out of memory|killed|ENOSPC/i.test(msg);
      return json(res, {
        error: oom
          ? 'Figma ZIP export ran out of memory. Export fewer pages (single-page SVG) or upgrade Backend RAM.'
          : (msg || 'Figma export failed'),
      }, 500);
    }
    return;
  }

  if (req.method === 'POST' && url.pathname === '/api/github/connect') {
    const ghUser = await getSessionUser(req);
    if (!ghUser) return json(res, { error: 'Not authenticated' }, 401);
    if (!isPaidPlan(ghUser.plan)) return json(res, { error: 'GitHub push requires a paid plan. Upgrade to publish your clones.' }, 403);
    try {
      const { token } = await readJsonBody(req, 50_000);
      if (!token || String(token).length < 20) return json(res, { error: 'GitHub token is required' }, 400);
      const me = await githubAPIRequest('GET', '/user', token);
      const reposResp = await githubAPIRequest('GET', '/user/repos?per_page=100&sort=updated&affiliation=owner,collaborator,organization_member', token);
      const repos = (reposResp.body || [])
        .filter(r => r?.permissions?.push || r?.permissions?.admin || r?.permissions?.maintain)
        .map(r => ({
          fullName: r.full_name,
          defaultBranch: r.default_branch || 'main',
          private: !!r.private,
          htmlUrl: r.html_url,
          pushedAt: r.pushed_at,
        }));
      return json(res, {
        ok: true,
        user: { login: me.body.login, name: me.body.name || me.body.login, avatarUrl: me.body.avatar_url },
        repos,
      });
    } catch(err) {
      return json(res, { error: friendlyGitHubError(err) }, githubErrorStatus(err));
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/github/branches') {
    const ghUser = await getSessionUser(req);
    if (!ghUser) return json(res, { error: 'Not authenticated' }, 401);
    if (!isPaidPlan(ghUser.plan)) return json(res, { error: 'GitHub push requires a paid plan. Upgrade to publish your clones.' }, 403);
    try {
      const { token, repo } = await readJsonBody(req, 50_000);
      if (!token || String(token).length < 20) return json(res, { error: 'GitHub token is required' }, 400);
      const parsedRepo = parseGitHubRepo(repo);
      if (!parsedRepo) return json(res, { error: 'Enter a GitHub repo as owner/repo or a github.com URL' }, 400);
      const { owner, repo: repoName } = parsedRepo;
      const branches = await githubAPIRequest('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/branches?per_page=100`, token);
      return json(res, {
        ok: true,
        branches: (branches.body || []).map(b => b.name).filter(Boolean),
      });
    } catch(err) {
      return json(res, { error: friendlyGitHubError(err) }, githubErrorStatus(err));
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/github/push') {
    const ghUser = await getSessionUser(req);
    if (!ghUser) return json(res, { error: 'Not authenticated' }, 401);
    if (!isPaidPlan(ghUser.plan)) return json(res, { error: 'GitHub push requires a paid plan. Upgrade to publish your clones.' }, 403);
    try {
      const {
        outDir: rawOutDir,
        token,
        repo,
        branch = 'main',
        targetPath = '',
        commitMessage = '',
        cleanTarget = false,
        createRepo = true,
      } = await readJsonBody(req, 200_000);
      const outDir = resolveCloneOutDir(rawOutDir);
      if (!outDir) return json(res, { error: 'Invalid output folder' }, 400);
      if (!await canUseCloneOutput(ghUser, outDir)) {
        return json(res, { error: 'Clone not found for your account (or output path is invalid). Re-open the capture from Library.' }, 404);
      }
      if (!token || String(token).length < 20) return json(res, { error: 'GitHub token is required' }, 400);
      const parsedRepo = parseGitHubRepo(repo);
      if (!parsedRepo) return json(res, { error: 'Enter a GitHub repo as owner/repo or a github.com URL' }, 400);
      const cleanBranch = String(branch || 'main').trim();
      if (!/^[A-Za-z0-9._/-]+$/.test(cleanBranch) || cleanBranch.includes('..')) return json(res, { error: 'Invalid branch name' }, 400);

      const { owner, repo: repoName } = parsedRepo;
      // Validate / create the GitHub repo BEFORE rematerializing (avoids long wait then "Not Found").
      let repoInfo;
      try {
        repoInfo = createRepo
          ? await ensureGitHubRepo(token, owner, repoName)
          : await githubAPIRequest('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`, token);
      } catch (ghErr) {
        return json(res, { error: friendlyGitHubError(ghErr) }, githubErrorStatus(ghErr));
      }

      let materialized;
      try {
        materialized = await materializeCloneOutput(outDir);
      } catch (matErr) {
        const matMsg = String(matErr?.message || matErr || '');
        console.warn(`[github/push] materialize failed for ${outDir}: ${matMsg}`);
        if (/Output folder not found|could not be loaded|Clone pages could not be loaded|Invalid output folder/i.test(matMsg)) {
          return json(res, { error: 'Clone files are missing from storage. Re-run the clone, then push again.' }, 404);
        }
        return json(res, { error: matMsg || 'Could not load clone files for GitHub push.' }, 404);
      }
      try {
        // Hosted Free: skip Next.js regen (slow/OOM). Push captured HTML + assets instead.
        if (!(IS_HOSTED || IS_LOW_MEMORY || IS_SERVERLESS)) {
          try {
            await regenerateCloneProject(materialized.dir);
          } catch (regenErr) {
            console.warn(`[github/push] regenerateCloneProject failed, pushing captured output: ${regenErr?.message || regenErr}`);
          }
        }
        const prefix = cleanGitPath(targetPath);
        const files = listOutputFiles(materialized.dir).filter((f) => {
          // GitHub rejects some path shapes; skip junk that breaks the whole commit.
          if (!f.rel || /[\x00-\x1f]/.test(f.rel)) return false;
          if (f.rel.includes('.git/') || f.rel === '.git') return false;
          return true;
        });
        if (!files.length) return json(res, { error: 'No files found in output folder. Re-run the clone, then push again.' }, 400);
        if (files.length > 5000) return json(res, { error: `Too many files for one GitHub commit (${files.length}/5000). Try a smaller clone.` }, 400);
        const tooLarge = files.find(f => f.size > 95 * 1024 * 1024);
        if (tooLarge) return json(res, { error: `File is too large for GitHub API: ${tooLarge.rel}` }, 400);

        const refPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/git/ref/heads/${cleanBranch.split('/').map(encodeURIComponent).join('/')}`;
        let baseCommitSha = null;
        let baseTreeSha = null;

        // Only bootstrap when GitHub says the repo is empty (409) — never trust size===0.
        let emptyLikely = isGitHubRepoEmpty(repoInfo);
        try {
          await githubAPIRequest('GET', refPath, token);
          emptyLikely = false;
        } catch (probeErr) {
          if (isGitHubEmptyRepoError(probeErr)) emptyLikely = true;
          else if (isGitHubRepoEmpty(repoInfo) && Number(probeErr?.statusCode) === 404) emptyLikely = true;
          else emptyLikely = false;
        }
        if (emptyLikely) {
          console.log(`[github/push] bootstrapping empty repo ${owner}/${repoName} branch=${cleanBranch}`);
          await bootstrapEmptyGitHubRepo(token, owner, repoName, cleanBranch);
          try {
            repoInfo = await githubAPIRequest('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}`, token);
          } catch {}
        }

        try {
          const ref = await githubAPIRequest('GET', refPath, token);
          baseCommitSha = ref.body.object.sha;
        } catch (refErr) {
          const defaultBranch = repoInfo.body?.default_branch || 'main';
          if (defaultBranch === cleanBranch) {
            if (isGitHubEmptyRepoError(refErr)) {
              await bootstrapEmptyGitHubRepo(token, owner, repoName, cleanBranch);
              const ref = await githubAPIRequest('GET', refPath, token);
              baseCommitSha = ref.body.object.sha;
            } else {
              throw refErr;
            }
          } else {
            try {
              const defaultRef = await githubAPIRequest(
                'GET',
                `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
                token,
              );
              await githubAPIRequest('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/git/refs`, token, {
                ref: `refs/heads/${cleanBranch}`,
                sha: defaultRef.body.object.sha,
              });
              baseCommitSha = defaultRef.body.object.sha;
            } catch (defaultErr) {
              if (isGitHubEmptyRepoError(defaultErr)) {
                await bootstrapEmptyGitHubRepo(token, owner, repoName, cleanBranch);
                const ref = await githubAPIRequest('GET', refPath, token).catch(async () => {
                  const dref = await githubAPIRequest(
                    'GET',
                    `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/git/ref/heads/${encodeURIComponent(defaultBranch)}`,
                    token,
                  );
                  await githubAPIRequest('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/git/refs`, token, {
                    ref: `refs/heads/${cleanBranch}`,
                    sha: dref.body.object.sha,
                  });
                  return dref;
                });
                baseCommitSha = ref.body.object.sha;
              } else {
                throw defaultErr;
              }
            }
          }
        }

        if (!baseCommitSha) {
          throw new Error('Could not resolve a GitHub branch after initializing the repository.');
        }

        let baseCommit = await githubAPIRequest(
          'GET',
          `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/git/commits/${baseCommitSha}`,
          token,
        );
        baseTreeSha = baseCommit.body.tree.sha;

        const message = String(commitMessage || '').trim() || `Import CLONYFY output (${outDir.split(/[\\/]/).pop()})`;
        // Hosted: smaller batches avoid request-body / timeout failures on large clones (e.g. Shopify).
        const batchSize = IS_HOSTED || IS_LOW_MEMORY ? 250 : 500;
        let commit = null;
        const allNextPaths = new Set();

        for (let offset = 0; offset < files.length; offset += batchSize) {
          const batch = files.slice(offset, offset + batchSize);
          const batchNo = Math.floor(offset / batchSize) + 1;
          const batchCount = Math.ceil(files.length / batchSize);
          console.log(`[github/push] ${owner}/${repoName} uploading batch ${batchNo}/${batchCount} (${batch.length} files)`);

          const { entries, nextPaths } = await githubUploadBlobsLimited(
            batch,
            owner,
            repoName,
            token,
            prefix,
            IS_HOSTED ? 2 : 6,
          );
          for (const p of nextPaths) allNextPaths.add(p);

          const isLast = offset + batchSize >= files.length;
          if (isLast && cleanTarget && baseTreeSha) {
            const tree = await githubAPIRequest('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/git/trees/${baseTreeSha}?recursive=1`, token);
            for (const item of tree.body.tree || []) {
              if (item.type !== 'blob') continue;
              const inTarget = prefix ? item.path === prefix || item.path.startsWith(`${prefix}/`) : true;
              if (inTarget && !allNextPaths.has(item.path)) {
                entries.push({ path: item.path, mode: '100644', type: 'blob', sha: null });
              }
            }
          }

          const newTree = await githubAPIRequest(
            'POST',
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/git/trees`,
            token,
            { base_tree: baseTreeSha, tree: entries },
          );
          const batchMessage = batchCount > 1
            ? `${message} (${batchNo}/${batchCount})`
            : message;
          commit = await githubAPIRequest(
            'POST',
            `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repoName)}/git/commits`,
            token,
            {
              message: batchMessage,
              tree: newTree.body.sha,
              parents: [baseCommitSha],
            },
          );
          await githubAPIRequest('PATCH', refPath, token, { sha: commit.body.sha, force: false });
          baseCommitSha = commit.body.sha;
          baseTreeSha = newTree.body.sha;
        }

        audit(ghUser.id, ghUser.name, 'github_push', `repo=${owner}/${repoName} files=${files.length}`, ip);
        return json(res, {
          ok: true,
          files: files.length,
          branch: cleanBranch,
          targetPath: prefix,
          commitUrl: commit?.body?.html_url,
          repoUrl: repoInfo.body.html_url,
          emptyRepoBootstrapped: !!emptyLikely,
          createdRepo: !!(createRepo && repoInfo.body?.created_at && Date.now() - Date.parse(repoInfo.body.created_at) < 60_000),
        });
      } finally {
        materialized.cleanup();
      }
    } catch(err) {
      console.error(
        `[github/push] failed: ${err?.message || err}` +
          (err?.githubPath ? ` [${err.githubMethod || ''} ${err.githubPath}]` : '') +
          (err?.statusCode ? ` status=${err.statusCode}` : ''),
      );
      return json(res, { error: friendlyGitHubError(err) }, githubErrorStatus(err));
    }
  }

  if (req.method === 'DELETE' && url.pathname === '/api/output') {
    const deleteUser = await getSessionUser(req);
    if (!deleteUser) return json(res, { error: 'Not authenticated' }, 401);
    const body = await readJsonBody(req);
    const outDir = resolveCloneOutDir(body?.outDir);
    if (!outDir) return json(res, { error: 'Invalid output folder' }, 400);
    if (!await canUseCloneOutput(deleteUser, outDir)) return json(res, { error: 'Not found' }, 404);
    try {
      if (existsSync(outDir)) rmSync(outDir, { recursive: true, force: true });
      for (const [id, job] of jobs.entries()) {
        if (sameCloneOutDir(job.outDir, outDir)) jobs.delete(id);
      }
      const clones = await getClonesByUser(deleteUser.id).catch(() => []);
      const clone = (clones || []).find(c => sameCloneOutDir(c.out_dir, outDir))
        || await getCloneByOutDir(outDir).catch(() => null);
      if (clone?.id) await deleteCloneById(clone.id);
      return json(res, { ok: true });
    } catch(err) { return json(res, { error: err.message }, 500); }
  }

  // ── Shares ─────────────────────────────────────────────────────────────────

  if (req.method === 'POST' && url.pathname === '/api/share/create') {
    const shareUser = await getSessionUser(req);
    if (!shareUser) return json(res, { error: 'Not authenticated' }, 401);
    const body = await readJsonBody(req);
    const outDir = resolveCloneOutDir(body?.outDir);
    const route = body?.route;
    const password = body?.password;
    const expiresInDays = body?.expiresInDays;
    if (!outDir) return json(res, { error: 'Invalid output folder' }, 400);
    if (!await canUseCloneOutput(shareUser, outDir)) return json(res, { error: 'Not found' }, 404);
    const quota = await consumeUsageQuota(shareUser, 'share', { outDir, record: false });
    if (!quota.allowed) return json(res, { error: quota.error, usage: { kind: 'share', used: quota.used, limit: quota.limit } }, 429);
    const map = await loadRouteMapAsync(outDir) || await inferRouteMapFromCapturedPages(outDir);
    if (!map) return json(res, { error: 'No clone found' }, 404);
    const shareId = randomUUID().replace(/-/g, '').slice(0, 14);
    let passwordHash = null, salt = null;
    if (password) {
      salt = randomUUID();
      passwordHash = createHash('sha256').update(salt + password + SHARE_PASSWORD_PEPPER).digest('hex');
    }
    const expiresAt = expiresInDays ? Date.now() + Number(expiresInDays) * 86400000 : null;
    try {
      await insertShare({ id: shareId, outDir, route: route || '/', createdAt: new Date().toISOString(), passwordHash, salt, expiresAt });
    } catch (err) {
      // Don't hand out a URL that was never persisted — it would 404 for
      // everyone the user sends it to.
      console.error('[share] insert failed:', err?.message || err);
      return json(res, { error: 'Could not save the share link. Please try again in a moment.' }, 500);
    }
    const recorded = await consumeUsageQuota(shareUser, 'share', { outDir });
    // Share pages are served by this Backend — never the Frontend origin.
    const _appUrl = apiPublicUrl(req);
    return json(res, { shareId, url: `${_appUrl}/share/${shareId}`, usage: { kind: 'share', used: recorded.used, limit: recorded.limit } });
  }

  if ((req.method === 'GET' || req.method === 'POST') && url.pathname.startsWith('/share/')) {
    const shareId = url.pathname.slice(7).split('/')[0].replace(/[^a-z0-9]/gi, '');
    const share = await getShare(shareId);
    if (!share) { res.writeHead(404, {'Content-Type':'text/html'}); res.end('<h2 style="font-family:system-ui;padding:40px">Share link not found or expired.</h2>'); return; }
    if (share.expires_at && Date.now() > share.expires_at) { res.writeHead(410, {'Content-Type':'text/html'}); res.end('<h2 style="font-family:system-ui;padding:40px">This share link has expired.</h2>'); return; }
    if (share.password_hash) {
      let pw = '';
      if (req.method === 'POST') {
        // Read password from POST body (form-encoded or JSON)
        const rawBody = await new Promise((ok, fail) => {
          let b = ''; let sz = 0;
          req.on('data', (c) => { sz += Buffer.byteLength(c); if (sz > 4096) { req.destroy(); } else { b += c; } });
          req.on('end', () => ok(b));
          req.on('error', fail);
        });
        const ct = req.headers['content-type'] || '';
        if (ct.includes('application/x-www-form-urlencoded')) {
          pw = new URLSearchParams(rawBody).get('pw') || '';
        } else {
          try { pw = JSON.parse(rawBody).pw || ''; } catch { /* ignore */ }
        }
      }
      const pwAction = url.pathname + (url.search || '');
      if (!pw) { res.writeHead(200, {'Content-Type':'text/html'}); res.end(sharePasswordFormHtml(shareId, undefined, pwAction)); return; }
      if (!checkRateLimit(`share_pw:${ip}:${shareId}`, 10, 300000)) { res.writeHead(429, {'Content-Type':'text/html'}); res.end(sharePasswordFormHtml(shareId, 'Too many attempts. Try again in 5 minutes.', pwAction)); return; }
      const hash = createHash('sha256').update(share.salt + pw + SHARE_PASSWORD_PEPPER).digest();
      const expected = Buffer.from(String(share.password_hash || ''), 'hex');
      const pwOk = hash.length === expected.length && timingSafeEqual(hash, expected);
      if (!pwOk) { res.writeHead(200, {'Content-Type':'text/html'}); res.end(sharePasswordFormHtml(shareId, 'Wrong password, try again.', pwAction)); return; }
      const requestedRoute = shareRouteFromPath(url.pathname, shareId, url.search) + (url.hash || '');
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Set-Cookie': shareAccessSetCookie(share),
      });
      res.end(shareWrapperHtml(shareId, requestedRoute));
      return;
    }
    let requestedRoute = shareRouteFromPath(url.pathname, shareId, url.search) + (url.hash || '');
    if (share.password_hash && !hasShareAccess(req, share)) {
      const pwAction = url.pathname + (url.search || '');
      res.writeHead(200, {'Content-Type':'text/html'});
      res.end(sharePasswordFormHtml(shareId, undefined, pwAction));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(shareWrapperHtml(shareId, requestedRoute));
    return;
  }

  // ── Admin ──────────────────────────────────────────────────────────────────

  // /admin HTML UI removed — admin APIs below remain.

  if (req.method === 'POST' && url.pathname === '/api/admin/auth') {
    if (!checkRateLimit(`admin_login:${ip}`, 5, 300000)) return json(res, { error: 'Too many attempts. Try again in 5 minutes.' }, 429);
    const { password } = await readJsonBody(req);
    if (!ADMIN_PASSWORD) return json(res, { error: 'Admin login is disabled because ADMIN_PASSWORD is missing on this server. Add it in your hosting environment variables, then redeploy/restart.' }, 503);
    const pwBuf = createHash('sha256').update(String(password || '')).digest();
    const adminBuf = createHash('sha256').update(ADMIN_PASSWORD).digest();
    if (!password || !timingSafeEqual(pwBuf, adminBuf)) return json(res, { error: 'Wrong password' }, 401);
    const token = createAdminToken();
    return json(res, { token });
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/logout') {
    adminSessions.delete(req.headers['x-admin-token'] || '');
    _persistAdminSessions();
    return json(res, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/stats') {
    if (!isAdmin(req)) return json(res, { error: 'Unauthorized' }, 401);
    const { totalUsers, blockedUsers, totalClones, totalErrors, pendingPayments, activePaidUsers, totalRevenue, monthRevenue } = await getAdminStats();
    const activeNow = [...jobs.values()].filter(isActiveJob).length;
    const mrr = activePaidUsers.reduce((s, u) => {
      const p = getPlanPrices(u.plan);
      return s + (u.billing_interval === 'annual' ? p.annual / 12 : p.monthly);
    }, 0);
    return json(res, {
      totalUsers, blockedUsers, totalClones, activeNow, totalRevenue, monthRevenue,
      mrr: Math.round(mrr * 100) / 100,
      arr: Math.round(mrr * 12 * 100) / 100,
      pendingPayments, totalErrors,
      growthUsers: activePaidUsers.filter(u => normalizePlan(u.plan) === 'growth').length,
      starterUsers: activePaidUsers.filter(u => normalizePlan(u.plan) === 'starter').length,
      unlimitedUsers: activePaidUsers.filter(u => normalizePlan(u.plan) === 'unlimited').length,
      proUsers: activePaidUsers.filter(u => normalizePlan(u.plan) === 'growth').length,
      enterpriseUsers: activePaidUsers.filter(u => normalizePlan(u.plan) === 'unlimited').length,
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/users') {
    if (!isAdmin(req)) return json(res, { error: 'Unauthorized' }, 401);
    const PAGE_SIZE = 50;
    const search = String(url.searchParams.get('search') || '').trim();
    const planFilter = String(url.searchParams.get('plan') || '').trim();
    const statusFilter = url.searchParams.get('status') || '';
    const page = Math.max(0, parseInt(url.searchParams.get('page') || '0', 10));
    const blockedFilter = statusFilter === 'blocked' ? true : statusFilter === 'active' ? false : null;
    const { users, total } = await getUsersPage({ search, plan: planFilter, blocked: blockedFilter, limit: PAGE_SIZE, offset: page * PAGE_SIZE });
    const clones = await getClonesByUserIds(users.map(u => u.id));
    const blockReasons = await getUserBlockReasons(users.filter(u => u.blocked === 1).map(u => u.id));
    const cloneMap = {};
    for (const c of clones) {
      if (!cloneMap[c.user_id]) cloneMap[c.user_id] = [];
      cloneMap[c.user_id].push(c);
    }
    return json(res, {
      users: users.map(u => {
        const uc = cloneMap[u.id] || [];
        return {
          id: u.id, name: u.name, email: u.email,
          plan: normalizePlan(u.plan), rawPlan: u.plan || 'free', planLabel: getPlanLabel(u.plan), planRenewsAt: u.plan_renews_at || null,
          billingInterval: u.billing_interval || 'monthly',
          blocked: u.blocked === 1, blockedReason: u.blocked_reason || blockReasons[u.id] || '', createdAt: u.created_at,
          cloneCount: uc.length,
          lastCloneAt: uc.length > 0 ? uc[0].started_at : null,
        };
      }),
      total,
      page,
      pageSize: PAGE_SIZE,
    });
  }

  if (req.method === 'PUT' && url.pathname.startsWith('/api/admin/users/')) {
    if (!isAdmin(req)) return json(res, { error: 'Unauthorized' }, 401);
    const userId = url.pathname.slice('/api/admin/users/'.length);
    const body = await readJsonBody(req);
    const user = await getUserById(userId);
    if (!user) return json(res, { error: 'User not found' }, 404);
    const fields = {};
    if (body.plan !== undefined) fields.plan = normalizePlan(body.plan);
    if (body.planRenewsAt !== undefined) fields.plan_renews_at = body.planRenewsAt;
    if (body.billingInterval !== undefined) fields.billing_interval = body.billingInterval;
    if (body.blocked !== undefined) {
      fields.blocked = body.blocked ? 1 : 0;
      fields.blocked_reason = body.blocked ? String(body.blockedReason || '').trim().slice(0, 500) : null;
      await setUserBlockReason(userId, fields.blocked_reason || '');
    }
    await updateUser(userId, fields);
    if (fields.blocked !== undefined) _invalidateUserSessions(userId);
    if (fields.plan !== undefined || fields.plan_renews_at !== undefined || fields.billing_interval !== undefined) _invalidateUserSessions(userId);
    audit(null, 'admin', 'admin_update_user', `userId=${userId} ${JSON.stringify(fields)}`, ip);
    return json(res, { ok: true });
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/admin/users/')) {
    if (!isAdmin(req)) return json(res, { error: 'Unauthorized' }, 401);
    const userId = url.pathname.slice('/api/admin/users/'.length);
    const user = await getUserById(userId);
    if (!user) return json(res, { error: 'User not found' }, 404);
    await deleteUserSessions(userId);
    _invalidateUserSessions(userId);
    await deleteUserClones(userId);
    await deleteUser(userId);
    audit(null, 'admin', 'admin_delete_user', `userId=${userId} email=${user.email}`, ip);
    return json(res, { ok: true });
  }

  // POST /api/admin/impersonate/:userId — create an impersonation session
  if (req.method === 'POST' && url.pathname.startsWith('/api/admin/impersonate/')) {
    if (!isAdmin(req)) return json(res, { error: 'Unauthorized' }, 401);
    const userId = url.pathname.slice('/api/admin/impersonate/'.length);
    const user = await getUserById(userId);
    if (!user) return json(res, { error: 'User not found' }, 404);
    const token = randomUUID();
    const adminTokenFingerprint = (req.headers['x-admin-token'] || '').slice(0, 8);
    await insertSession({ token, userId: user.id, createdAt: new Date().toISOString(), expiresAt: Date.now() + 2*60*60*1000, impersonatedBy: 'admin' });
    audit(null, 'admin', 'impersonate', `userId=${userId} email=${user.email} adminToken=${adminTokenFingerprint}...`, ip);
    return json(res, { token, user: userPublic(user) });
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/clones') {
    if (!isAdmin(req)) return json(res, { error: 'Unauthorized' }, 401);
    const clones = await getAllClones();
    const userFilter = url.searchParams.get('userId') || '';
    const search = (url.searchParams.get('search') || '').toLowerCase();
    const statusFilter = url.searchParams.get('status') || '';
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const pageSize = 50;
    const running = [...jobs.values()]
      .filter(isActiveJob)
      .map(j => ({ id: j.id, user_id: j.userId, user_name: j.userName || 'Anonymous', url: j.url, status: j.status, pages: j.pages, assets: j.assets, started_at: j.startedAt, completed_at: null }));
    const runningIds = new Set(running.map(j => j.id));
    const all = [
      ...running,
      ...clones.filter(c => !runningIds.has(c.id)).map(c => ({ ...c, user_name: c.user_name || 'Deleted' })),
    ]
      .filter(c => !userFilter || c.user_id === userFilter)
      .filter(c => !statusFilter || c.status === statusFilter)
      .filter(c => !search || (c.url || '').toLowerCase().includes(search) || (c.user_name || '').toLowerCase().includes(search));
    const total = all.length;
    const items = all.slice((page - 1) * pageSize, page * pageSize).map(c => ({
      id: c.id, userId: c.user_id, userName: c.user_name, url: c.url,
      status: c.status, pages: c.pages, assets: c.assets,
      startedAt: c.started_at, completedAt: c.completed_at,
    }));
    return json(res, { items, total, page, pageSize });
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/admin/clones/')) {
    if (!isAdmin(req)) return json(res, { error: 'Unauthorized' }, 401);
    const cloneId = url.pathname.slice('/api/admin/clones/'.length);
    await deleteCloneById(cloneId);
    return json(res, { ok: true });
  }

  // GET /api/admin/audit?page=&action=
  if (req.method === 'GET' && url.pathname === '/api/admin/audit') {
    if (!isAdmin(req)) return json(res, { error: 'Unauthorized' }, 401);
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const pageSize = 100;
    const items = await getAuditLog(pageSize, (page - 1) * pageSize);
    const total = await getAuditCount().c;
    return json(res, { items, total, page, pageSize });
  }

  // POST /api/admin/announce — broadcast email to users
  if (req.method === 'POST' && url.pathname === '/api/admin/announce') {
    if (!isAdmin(req)) return json(res, { error: 'Unauthorized' }, 401);
    const { title, body: msgBody, sentTo } = await readJsonBody(req);
    if (!title || !msgBody) return json(res, { error: 'Title and body are required' }, 400);
    const validTargets = ['all', 'free', ...ALL_PAID_PLAN_KEYS, 'paid'];
    const target = validTargets.includes(sentTo) ? sentTo : 'all';
    const users = await getAllUsers();
    const targets = users.filter(u => {
      if (target === 'all') return true;
      if (target === 'paid') return isPaidPlan(u.plan);
      return normalizePlan(u.plan) === normalizePlan(target);
    });
    const id = randomUUID();
    await insertAnnouncement({ id, title, body: msgBody, sentTo: target, recipientCount: targets.length, createdAt: new Date().toISOString() });
    audit(null, 'admin', 'announce', `to=${target} recipients=${targets.length} title="${title}"`, ip);
    // Send emails (fire and forget)
    (async () => {
      for (const u of targets) {
        await sendEmail(u.email, title,
          renderEmail('announcement', { SUBJECT: title, NAME: u.name, TITLE: title, BODY: htmlEsc(msgBody).replace(/\n/g, '<br>') })
        ).catch(() => {});
      }
    })();
    return json(res, { ok: true, recipientCount: targets.length });
  }

  // GET /api/admin/announcements
  if (req.method === 'GET' && url.pathname === '/api/admin/announcements') {
    if (!isAdmin(req)) return json(res, { error: 'Unauthorized' }, 401);
    return json(res, await getAllAnnouncements());
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/contacts') {
    if (!isAdmin(req)) return json(res, { error: 'Unauthorized' }, 401);
    const limit = Math.max(1, Math.min(300, parseInt(url.searchParams.get('limit') || '100', 10) || 100));
    return json(res, await getContactSubmissions(limit));
  }

  // ── Payments ───────────────────────────────────────────────────────────────

  if (req.method === 'GET' && url.pathname === '/api/payments/settings') {
    const s = getStripeSettings();
    const stripeReason = stripeUnavailableReason();
    return json(res, {
      btc: s.btc, eth: s.eth, usdt_trc20: s.usdt_trc20,
      paypal_email: s.paypal_email, paypal_me: s.paypal_me,
      stripe_enabled: !!s.stripe_secret_key,
      stripe_ready: !stripeReason,
      stripe_error: stripeReason,
      stripe_publishable_key: s.stripe_publishable_key || '',
      google_oauth_enabled: !!s.google_client_id,
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/public-config') {
    const s = getCachedSettings();
    const enabled = s.affiliate_enabled === true || s.affiliate_enabled === 'true';
    return json(res, {
      affiliate_enabled: enabled,
      affiliate_program_url: s.affiliate_program_url || 'https://affonso.io/',
      affiliate_public_id: enabled ? (s.affiliate_public_id || DEFAULT_AFFONSO_PUBLIC_ID) : '',
      affiliate_dashboard_enabled: enabled && !!(s.affiliate_api_key && s.affiliate_program_id),
      figma_community_plugin_url: String(process.env.FIGMA_COMMUNITY_PLUGIN_URL || '').trim(),
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/affiliate/embed-token') {
    const user = await getSessionUser(req);
    if (!user) return json(res, { error: 'Sign in to open the affiliate dashboard.' }, 401);
    if (!checkRateLimit(`affiliate_embed:${user.id}`, 10, 600000)) return json(res, { error: 'Too many requests.' }, 429);
    const s = getCachedSettings();
    const enabled = s.affiliate_enabled === true || s.affiliate_enabled === 'true';
    if (!enabled) return json(res, { error: 'Affiliate program is disabled.' }, 404);
    if (!s.affiliate_api_key || !s.affiliate_program_id) {
      return json(res, { ok: true, token: '', link: localReferralLink(req, user), configured: false });
    }
    try {
      const embed = await createAffonsoEmbedToken(user, s);
      if (!embed.token) return json(res, { error: 'Affonso did not return an embed token.' }, 502);
      return json(res, { ok: true, token: embed.token, link: embed.link || localReferralLink(req, user) });
    } catch (err) {
      return json(res, { error: err.message || 'Affonso request failed. Check the API key and program ID.' }, 502);
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/affiliate/track') {
    const body = await readJsonBody(req);
    const referralCode = cleanReferralCode(body.referral || body.via || '');
    if (!referralCode) return json(res, { ok: false, error: 'Missing referral code' }, 400);
    if (!checkRateLimit(`affiliate_track:${ip}:${referralCode}`, 30, 3600000)) return json(res, { ok: true, throttled: true });
    const ownerId = await getAffiliateOwnerBySlug(referralCode);
    if (!ownerId) return json(res, { ok: true, tracked: false });
    const visitorId = cleanReferralCode(body.visitorId || createHash('sha256').update(`${ip}:${referralCode}`).digest('hex').slice(0, 32));
    await addAffiliateVisit(ownerId, {
      visitorId,
      source: referralCode,
      path: String(body.path || '').slice(0, 200),
      userAgent: String(req.headers['user-agent'] || '').slice(0, 200),
      createdAt: new Date().toISOString(),
    });
    return json(res, { ok: true, tracked: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/affiliate/dashboard') {
    const user = await getSessionUser(req);
    if (!user) return json(res, { error: 'Sign in to view your affiliate dashboard.' }, 401);
    if (!checkRateLimit(`affiliate_dashboard:${user.id}`, 20, 600000)) return json(res, { error: 'Too many requests.' }, 429);
    const s = getCachedSettings();
    const enabled = s.affiliate_enabled === true || s.affiliate_enabled === 'true';
    if (!enabled) return json(res, { error: 'Affiliate program is disabled.' }, 404);
    await saveAffiliateSlug(affiliateSlug(user), user.id).catch(() => {});
    const localReferrals = await getAffiliateReferrals(user.id).catch(() => []);
    const localVisits = await getAffiliateVisits(user.id).catch(() => []);
    if (!s.affiliate_api_key || !s.affiliate_program_id) {
      return json(res, {
        ok: true,
        configured: false,
        needs: ['Affonso API Key', 'Affonso Program ID'],
        data: {
          link: localReferralLink(req, user),
          referralLink: localReferralLink(req, user),
          stats: { clicks: localVisits.length, referrals: localReferrals.length, conversions: 0, rewards: 0 },
          referrals: localReferrals,
          visits: localVisits,
          rewards: [],
        },
        message: 'Your referral link is ready. Affonso reporting will appear here after the API key and program ID are connected in Admin Settings.',
      });
    }
    try {
      const embed = await createAffonsoEmbedToken(user, s);
      if (!embed.token) return json(res, { error: 'Affonso did not return an embed token.' }, 502);
      const data = await getAffonsoEmbedData(embed.token);
      const link = data.link || data.referralLink || data.referral_link || data.partner?.referralLink || embed.link || localReferralLink(req, user);
      const affonsoReferrals = Array.isArray(data.referrals) ? data.referrals : [];
      return json(res, {
        ok: true,
        configured: true,
        token: embed.token,
        data: {
          ...data,
          link,
          referralLink: link,
          referrals: [...localReferrals, ...affonsoReferrals],
          visits: localVisits,
          stats: {
            ...(data.stats || {}),
            clicks: Math.max(Number(data.stats?.clicks || data.stats?.visits || 0), localVisits.length),
            referrals: Math.max(Number(data.stats?.referrals || 0), localReferrals.length + affonsoReferrals.length),
          },
          partner: { ...(data.partner || embed.partner || {}), referralLink: link },
        },
      });
    } catch (err) {
      return json(res, { error: err.message || 'Affonso dashboard failed to load.' }, 502);
    }
  }

  if (req.method === 'GET' && url.pathname === '/api/payments/plans') {
    const limits = Object.fromEntries(Object.keys(PLAN_LIMITS).map(plan => [plan, getEffectivePlanLimits(plan)]));
    return json(res, {
      plans: PLAN_PRICES,
      limits,
      labels: PLAN_LABELS,
      aliases: PLAN_ALIASES,
    });
  }

  if (req.method === 'POST' && url.pathname === '/api/payments/submit') {
    const user = await getSessionUser(req);
    if (!user) return json(res, { error: 'Sign in to submit a payment.' }, 401);
    if (!checkRateLimit(`pay_submit:${ip}`, 5, 3600000)) return json(res, { error: 'Too many requests.' }, 429);
    const body = await readJsonBody(req);
    const plan = normalizePlan(body.plan);
    const { method, txId, note, promoCode, interval } = body;
    if (!isPaidPlan(plan)) return json(res, { error: 'Invalid plan.' }, 400);
    const billingInterval = interval === 'annual' ? 'annual' : 'monthly';
    const validMethods = ['paypal', 'crypto_btc', 'crypto_eth', 'crypto_usdt'];
    if (!method || !validMethods.includes(method)) return json(res, { error: 'Invalid payment method.' }, 400);
    if (!txId || String(txId).trim().length < 4) return json(res, { error: 'Transaction ID is required.' }, 400);
    if (await getPendingPaymentByUserPlan(user.id, plan, 'pending')) return json(res, { error: 'You already have a pending payment for this plan. Please wait for confirmation.' }, 409);
    let discountPercent = 0, appliedCode = null;
    if (promoCode) {
      const codeRow = await getPromoCode(String(promoCode).toUpperCase().trim());
      if (codeRow &&
          (!codeRow.valid_until || new Date(codeRow.valid_until) > new Date()) &&
          (!codeRow.max_uses || codeRow.used_count < codeRow.max_uses) &&
          (!codeRow.plans || codeRow.plans === '[]' || safeJsonParse(codeRow.plans).includes(plan))) {
        discountPercent = codeRow.discount_percent || 0;
        appliedCode = codeRow.code;
        await incrementPromoUsed(codeRow.code);
      }
    }
    const prices = getPlanPrices(plan);
    const baseAmount = prices[billingInterval] || 0;
    const amount = Math.round(Math.max(0, baseAmount * (1 - discountPercent / 100)) * 100) / 100;
    const payment = {
      id: randomUUID(), userId: user.id, userName: user.name, userEmail: user.email,
      plan, amount, currency: 'USD', method, txId: String(txId).trim(),
      note: String(note || '').trim().slice(0, 500),
      promoCode: appliedCode, discountPercent, interval: billingInterval,
      status: 'pending', submittedAt: new Date().toISOString(),
    };
    await insertPayment(payment);
    audit(user.id, user.name, 'payment_submit', `plan=${plan} interval=${billingInterval} amount=${amount}`, ip);
    return json(res, { ok: true, id: payment.id });
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/payments') {
    if (!isAdmin(req)) return json(res, { error: 'Unauthorized' }, 401);
    const statusF = url.searchParams.get('status') || '';
    const methodF = url.searchParams.get('method') || '';
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const pageSize = 50;
    let payments = await getAllPayments();
    if (statusF) payments = payments.filter(p => p.status === statusF);
    if (methodF) payments = payments.filter(p => p.method === methodF);
    const total = payments.length;
    const items = payments.slice((page - 1) * pageSize, page * pageSize).map(p => ({
      id: p.id, userId: p.user_id, userName: p.user_name, userEmail: p.user_email,
      plan: p.plan, interval: p.interval, amount: p.amount, currency: p.currency,
      method: p.method, txId: p.tx_id, note: p.note,
      promoCode: p.promo_code, discountPercent: p.discount_percent,
      status: p.status, submittedAt: p.submitted_at, processedAt: p.processed_at,
    }));
    return json(res, { items, total, page, pageSize });
  }

  if (req.method === 'PUT' && url.pathname.startsWith('/api/admin/payments/')) {
    if (!isAdmin(req)) return json(res, { error: 'Unauthorized' }, 401);
    const payId = url.pathname.slice('/api/admin/payments/'.length);
    const { status, reason } = await readJsonBody(req);
    if (!['confirmed', 'rejected'].includes(status)) return json(res, { error: 'Invalid status' }, 400);
    const payment = await getPaymentById(payId);
    if (!payment) return json(res, { error: 'Payment not found' }, 404);
    const processedAt = new Date().toISOString();
    await updatePayment({ id: payId, status, processedAt, reason: String(reason || '').trim().slice(0, 500) });
    if (status === 'confirmed' && payment.user_id) {
      const user = await getUserById(payment.user_id);
      if (user) {
        const interval = payment.interval || 'monthly';
        const renewDate = new Date();
        if (interval === 'annual') renewDate.setFullYear(renewDate.getFullYear() + 1);
        else renewDate.setMonth(renewDate.getMonth() + 1);
        const confirmedPlan = await activatePaidPlanForUser(payment.user_id, { plan: payment.plan, interval, renewsAt: renewDate });
        const s = getCachedSettings();
        const appUrl = s.app_url || `http://localhost:${PORT}`;
        sendEmail(user.email, `Payment confirmed — ${getPlanLabel(confirmedPlan)} plan activated`,
          renderEmail('payment-confirmed', { SUBJECT: `${getPlanLabel(confirmedPlan)} plan activated`, NAME: user.name, PLAN: getPlanLabel(confirmedPlan), AMOUNT: String(payment.amount), INTERVAL: interval, RENEWS_AT: renewDate.toLocaleDateString() })
        ).catch(() => {});
        audit(null, 'admin', 'payment_confirmed', `userId=${user.id} plan=${confirmedPlan} amount=${payment.amount}`, ip);
      }
    }
    if (status === 'rejected' && payment.user_id) {
      const user = await getUserById(payment.user_id);
      if (user) {
        const reasonBlock = reason ? `<p style="background:#fef2f2;border:1px solid #fecaca;border-radius:8px;padding:12px 16px;font-size:13px;color:#991b1b;margin:0 0 16px">Reason: ${htmlEsc(reason)}</p>` : '';
        sendEmail(user.email, 'Your payment could not be confirmed',
          renderEmail('payment-rejected', { SUBJECT: 'Payment not confirmed', NAME: user.name, PLAN: getPlanLabel(payment.plan), REASON_BLOCK: reasonBlock })
        ).catch(() => {});
      }
    }
    return json(res, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/revenue') {
    if (!isAdmin(req)) return json(res, { error: 'Unauthorized' }, 401);
    const payments = await getAllPayments();
    const confirmed = payments.filter(p => p.status === 'confirmed');
    const now3 = new Date();
    const monthStart = new Date(now3.getFullYear(), now3.getMonth(), 1);
    const last6 = [];
    for (let i = 5; i >= 0; i--) {
      const d = new Date(now3.getFullYear(), now3.getMonth() - i, 1);
      const end = new Date(now3.getFullYear(), now3.getMonth() - i + 1, 1);
      const label = d.toLocaleString('en-US', { month: 'short', year: '2-digit' });
      const amount = confirmed.filter(p => { const pd = new Date(p.processed_at); return pd >= d && pd < end; }).reduce((s, p) => s + (p.amount || 0), 0);
      last6.push({ label, amount });
    }
    const byPlan = {}, byMethod = {}, byInterval = {};
    for (const p of confirmed) {
      const planKey = normalizePlan(p.plan);
      byPlan[planKey] = (byPlan[planKey] || 0) + (p.amount || 0);
      byMethod[p.method] = (byMethod[p.method] || 0) + (p.amount || 0);
      byInterval[p.interval || 'monthly'] = (byInterval[p.interval || 'monthly'] || 0) + (p.amount || 0);
    }
    // MRR from active subscriptions
    const users = await getAllUsers();
    const activePaid = users.filter(u => isPaidPlan(u.plan) && u.plan_renews_at && new Date(u.plan_renews_at) > now3);
    const mrr = activePaid.reduce((s, u) => {
      const p = getPlanPrices(u.plan);
      return s + (u.billing_interval === 'annual' ? p.annual / 12 : p.monthly);
    }, 0);
    // Churn: users who downgraded to free in the last 30 days (approximated by renewal_reminder_sent)
    return json(res, {
      totalRevenue: confirmed.reduce((s, p) => s + (p.amount || 0), 0),
      monthRevenue: confirmed.filter(p => new Date(p.processed_at) >= monthStart).reduce((s, p) => s + (p.amount || 0), 0),
      mrr: Math.round(mrr * 100) / 100,
      arr: Math.round(mrr * 12 * 100) / 100,
      activePaidUsers: activePaid.length,
      confirmedCount: confirmed.length,
      pendingCount: payments.filter(p => p.status === 'pending').length,
      rejectedCount: payments.filter(p => p.status === 'rejected').length,
      byPlan, byMethod, byInterval,
      last6months: last6,
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/settings') {
    if (!isAdmin(req)) return json(res, { error: 'Unauthorized' }, 401);
    const raw = getCachedSettings();
    const stripe = getStripeSettings(raw);
    const body = {
      ...raw,
      stripe_publishable_key: raw.stripe_publishable_key || stripe.stripe_publishable_key,
      stripe_secret_key_configured: !!stripe.stripe_secret_key,
      stripe_webhook_secret_configured: !!stripe.stripe_webhook_secret,
    };
    for (const plan of ALL_PAID_PLAN_KEYS) {
      for (const interval of ['monthly', 'annual']) {
        const key = STRIPE_PRICE_KEY(plan, interval);
        body[key] = raw[key] || stripe[key] || '';
      }
    }
    return json(res, body);
  }

  if (req.method === 'PUT' && url.pathname === '/api/admin/settings') {
    if (!isAdmin(req)) return json(res, { error: 'Unauthorized' }, 401);
    const body = await readJsonBody(req);
    const current = getCachedSettings();
    const plainKeys = [
      'btc', 'eth', 'usdt_trc20', 'paypal_email', 'paypal_me', 'app_note',
      'smtp_host', 'smtp_port', 'smtp_user', 'smtp_pass', 'smtp_from', 'app_url',
      'support_email',
      'affiliate_enabled', 'affiliate_program_url', 'affiliate_public_id',
      'affiliate_program_id', 'affiliate_group_id', 'affiliate_api_key',
      'stripe_publishable_key',
      'stripe_price_starter_monthly', 'stripe_price_starter_annual',
      'stripe_price_popular_monthly', 'stripe_price_popular_annual',
      'stripe_price_growth_monthly', 'stripe_price_growth_annual',
      'stripe_price_unlimited_monthly', 'stripe_price_unlimited_annual',
      'stripe_price_pro_monthly', 'stripe_price_pro_annual',
      'stripe_price_enterprise_monthly', 'stripe_price_enterprise_annual',
      // secret fields — only overwrite when a real value is sent (not masked placeholder)
      'stripe_secret_key', 'stripe_webhook_secret',
      'google_client_id', 'google_client_secret',
    ];
    for (const k of plainKeys) {
      if (body[k] !== undefined && !isMaskedSecret(body[k])) {
        const value = String(body[k] || '').trim();
        if (k === 'affiliate_enabled') {
          current[k] = value === 'true' || value === '1' || value === 'yes' ? 'true' : 'false';
          continue;
        }
        if (k === 'affiliate_program_url') {
          const cleanUrl = normalizeAffiliateUrl(value);
          if (cleanUrl === null) return json(res, { error: 'Affiliate program URL must be a valid http(s) URL.' }, 400);
          current[k] = cleanUrl;
          continue;
        }
        if (['affiliate_public_id', 'affiliate_program_id', 'affiliate_group_id'].includes(k)) {
          const publicId = cleanAffiliatePublicId(value);
          if (publicId === null) return json(res, { error: 'Affonso IDs can only contain letters, numbers, underscores, and dashes.' }, 400);
          current[k] = publicId;
          continue;
        }
        const stripeError = validateStripeSetting(k, value);
        if (stripeError) return json(res, { error: stripeError }, 400);
        current[k] = value;
      }
    }
    if (body.smtp_secure !== undefined) current.smtp_secure = body.smtp_secure === true || body.smtp_secure === 'true';
    await saveSettings(current);
    await invalidateSettingsCache();
    _mailerTransport = null;
    _stripeInstance = null; // force rebuild with new keys
    return json(res, { ok: true });
  }

  // ── Static pages ───────────────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/admin/stripe/test') {
    if (!isAdmin(req)) return json(res, { error: 'Unauthorized' }, 401);
    const stripe = getStripe();
    const reason = stripeUnavailableReason();
    if (!stripe) return json(res, { ok: false, error: reason || 'Stripe is not configured.' }, 503);
    try {
      const account = await stripe.accounts.retrieve();
      return json(res, {
        ok: true,
        accountId: account.id,
        mode: _stripeKey.startsWith('sk_test_') ? 'test' : 'live',
        chargesEnabled: !!account.charges_enabled,
        payoutsEnabled: !!account.payouts_enabled,
      });
    } catch (err) {
      return json(res, { ok: false, error: err.message }, 502);
    }
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/resend-verification') {
    const user = await getSessionUser(req);
    if (!user) return json(res, { error: 'Not authenticated' }, 401);
    if (user.email_verified === 1 || user.email_verified === true) return json(res, { ok: true, alreadyVerified: true });
    if (!checkRateLimit(`verify:${user.id}`, 3, 3600000)) return json(res, { error: 'Too many verification emails. Try again later.' }, 429);

    const verifyToken = randomUUID().replace(/-/g, '');
    await updateUser(user.id, { verify_token: verifyToken, verify_expiry: Date.now() + 24 * 3600 * 1000 });
    const appUrl = publicAppUrl(req);
    sendEmail(user.email, 'Verify your CLONYFY email',
      renderEmail('verify-email', { SUBJECT: 'Verify your email', NAME: user.name, LINK: `${appUrl}/api/auth/verify-email?token=${verifyToken}` })
    ).catch(() => {});
    return json(res, { ok: true });
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/verify-email') {
    const token = String(url.searchParams.get('token') || '').trim();
    const frontend = frontendPublicUrl(req);
    const redirectTo = (status) => {
      res.writeHead(302, { Location: `${frontend}/dashboard?verify=${encodeURIComponent(status)}` });
      res.end();
    };
    if (!token) return redirectTo('missing');
    const user = await getUserByVerifyToken(token, Date.now());
    if (!user) return redirectTo('expired');
    await updateUser(user.id, { email_verified: 1, verify_token: null, verify_expiry: null });
    audit(user.id, user.name, 'email_verified', null, ip);
    return redirectTo('success');
  }

  // ── Password reset ─────────────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/auth/forgot-password') {
    if (!checkRateLimit(`forgot:${ip}`, 5, 3600000)) return json(res, { error: 'Too many requests' }, 429);
    const { email } = await readJsonBody(req);
    if (!email) return json(res, { ok: true });
    const normalizedEmail = String(email).toLowerCase().trim();
    // Silent rate limit per email — avoids user enumeration via timing
    if (!checkRateLimit(`forgot_email:${normalizedEmail}`, 3, 3600000)) return json(res, { ok: true });
    const user = await getUserByEmail(normalizedEmail);
    if (user) {
      const resetToken = randomUUID().replace(/-/g, '');
      await updateUser(user.id, { reset_token: resetToken, reset_expiry: Date.now() + 3600 * 1000 });
      const s = getCachedSettings();
      const frontendBase = String(process.env.FRONTEND_URL || process.env.PUBLIC_APP_URL || s.app_url || `http://localhost:${PORT}`).replace(/\/$/, '');
      sendEmail(user.email, 'Reset your CLONYFY password',
        renderEmail('reset-password', { SUBJECT: 'Reset your password', NAME: user.name, LINK: `${frontendBase}/reset-password?token=${resetToken}` })
      ).catch(() => {});
    }
    return json(res, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/auth/reset-password') {
    const { token, password } = await readJsonBody(req);
    if (!token || !password || password.length < 8) return json(res, { error: 'Token and new password (min 8 chars) required' }, 400);
    const user = await getUserByResetToken(token, Date.now());
    if (!user) return json(res, { error: 'Reset link is invalid or expired' }, 400);
    const { hash: newHash, salt: newSalt } = await hashPw(password);
    await updateUser(user.id, { hash: newHash, salt: newSalt, reset_token: null, reset_expiry: null });
    _invalidateUserSessions(user.id);
    audit(user.id, user.name, 'password_reset', null, ip);
    return json(res, { ok: true });
  }

  // ── Announcements (public, last 3) ─────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/announcements') {
    const all = await getAllAnnouncements();
    return json(res, all.slice(0, 3).map(a => ({ id: a.id, title: a.title, body: a.body, createdAt: a.created_at })));
  }

  // ── User dashboard & billing ───────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/user/dashboard') {
    const user = await getSessionUser(req);
    if (!user) return json(res, { error: 'Not authenticated' }, 401);
    if (user.blocked) return await blockedUserResponse(res, user);
    const userClones = await getClonesByUser(user.id);
    const usage = await getUserUsageSummary(user);
    const totalPages = userClones.reduce((s, c) => s + (c.pages || 0), 0);
    const totalAssets = userClones.reduce((s, c) => s + (c.assets || 0), 0);
    return json(res, {
      user: userPublic(user),
      impersonatedBy: user._impersonatedBy || null,
      usage: {
        ...usage,
        totalClones: userClones.length,
        totalPages,
        totalAssets,
        limitThisMonth: usage.limits.clonesPerMonth,
      },
      recentClones: userClones.slice(0, 10).map(c => ({ id: c.id, url: c.url, status: c.status, pages: c.pages, startedAt: c.started_at })),
    });
  }

  if (req.method === 'GET' && url.pathname === '/api/user/billing') {
    const user = await getSessionUser(req);
    if (!user) return json(res, { error: 'Not authenticated' }, 401);
    if (user.blocked) return await blockedUserResponse(res, user);
    return json(res, { payments: await getPaymentsByUser(user.id) });
  }

  if (req.method === 'PUT' && url.pathname === '/api/user/profile') {
    const user = await getSessionUser(req);
    if (!user) return json(res, { error: 'Not authenticated' }, 401);
    if (user.blocked) return await blockedUserResponse(res, user);
    const { name, password } = await readJsonBody(req);
    const fields = {};
    if (name !== undefined) {
      const trimmed = String(name).trim();
      if (!trimmed) return json(res, { error: 'Name is required' }, 400);
      fields.name = trimmed;
    }
    if (password) {
      if (password.length < 8) return json(res, { error: 'Password must be at least 8 characters' }, 400);
      const { hash: pwHash, salt: pwSalt } = await hashPw(password);
      fields.hash = pwHash;
      fields.salt = pwSalt;
    }
    await updateUser(user.id, fields);
    return json(res, { ok: true });
  }

  if (req.method === 'POST' && url.pathname === '/api/user/cancel-subscription') {
    const user = await getSessionUser(req);
    if (!user) return json(res, { error: 'Not authenticated' }, 401);
    if (!isPaidPlan(user.plan)) return json(res, { error: 'No active subscription to cancel' }, 400);
    if (user.stripe_subscription_id) {
      const stripe = getStripe();
      if (!stripe) return json(res, { error: stripeUnavailableReason() || 'Stripe is not configured. Contact support.' }, 503);
      try {
        await stripe.subscriptions.update(user.stripe_subscription_id, { cancel_at_period_end: true });
      } catch (err) {
        return json(res, { error: `Stripe cancellation failed: ${err.message}` }, 502);
      }
    }
    await updateUser(user.id, { cancel_at_period_end: 1 });
    audit(user.id, user.name, 'cancel_subscription', user.plan, ip);
    return json(res, { ok: true });
  }

  // DELETE /api/user/account — GDPR account deletion
  if (req.method === 'DELETE' && url.pathname === '/api/user/account') {
    const user = await getSessionUser(req);
    if (!user) return json(res, { error: 'Not authenticated' }, 401);
    const { password } = await readJsonBody(req);
    if (!password) return json(res, { error: 'Password confirmation required' }, 400);
    const ok = await verifyPw(password, user);
    if (!ok) return json(res, { error: 'Wrong password' }, 401);
    const token = user._sessionToken;
    audit(user.id, user.name, 'account_deleted', `email=${user.email}`, ip);
    await deleteUserSessions(user.id);
    await deleteUserClones(user.id);
    await deleteUser(user.id);
    return json(res, { ok: true });
  }

  // GET /api/user/export — GDPR data export
  if (req.method === 'GET' && url.pathname === '/api/user/export') {
    const user = await getSessionUser(req);
    if (!user) return json(res, { error: 'Not authenticated' }, 401);
    if (user.blocked) return await blockedUserResponse(res, user);
    const clones = await getClonesByUser(user.id);
    const payments = await getPaymentsByUser(user.id);
    const exportData = {
      exportedAt: new Date().toISOString(),
      user: {
        id: user.id, name: user.name, email: user.email,
        plan: normalizePlan(user.plan), rawPlan: user.plan, createdAt: user.created_at,
        emailVerified: user.email_verified === 1,
      },
      clones: clones.map(c => ({ id: c.id, url: c.url, status: c.status, pages: c.pages, startedAt: c.started_at, completedAt: c.completed_at })),
      payments: payments.map(p => ({ id: p.id, plan: p.plan, amount: p.amount, currency: p.currency, method: p.method, interval: p.interval, status: p.status, txId: p.tx_id, submittedAt: p.submitted_at, processedAt: p.processed_at })),
    };
    audit(user.id, user.name, 'data_export', null, ip);
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Disposition': `attachment; filename="clonyfy-data-${user.id}.json"`,
    });
    res.end(JSON.stringify(exportData, null, 2));
    return;
  }

  // ── Promo codes ────────────────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/payments/validate-promo') {
    const { code, plan } = await readJsonBody(req);
    if (!code) return json(res, { error: 'Code required' }, 400);
    const found = await getPromoCode(String(code).toUpperCase().trim());
    if (!found ||
        (found.valid_until && new Date(found.valid_until) <= new Date()) ||
        (found.max_uses && found.used_count >= found.max_uses) ||
        (found.plans && found.plans !== '[]' && plan && !safeJsonParse(found.plans).includes(plan))) {
      return json(res, { error: 'Invalid or expired promo code' }, 404);
    }
    return json(res, { valid: true, code: found.code, discountPercent: found.discount_percent || 0, description: found.description || '' });
  }

  if (req.method === 'GET' && url.pathname === '/api/admin/promo-codes') {
    if (!isAdmin(req)) return json(res, { error: 'Unauthorized' }, 401);
    const promoCodes = await getAllPromoCodes();
    return json(res, promoCodes.map(c => ({ ...c, plans: safeJsonParse(c.plans || '[]') })));
  }

  if (req.method === 'POST' && url.pathname === '/api/admin/promo-codes') {
    if (!isAdmin(req)) return json(res, { error: 'Unauthorized' }, 401);
    const body = await readJsonBody(req);
    const code = String(body.code || '').toUpperCase().trim().replace(/[^A-Z0-9_-]/g, '');
    if (!code || code.length < 3) return json(res, { error: 'Code must be at least 3 characters' }, 400);
    const discountPercent = Math.min(100, Math.max(0, parseInt(body.discountPercent, 10) || 0));
    if (await getPromoCode(code)) return json(res, { error: 'Code already exists' }, 409);
    await insertPromoCode({
      code, discountPercent,
      description: String(body.description || '').trim().slice(0, 200),
      maxUses: body.maxUses ? parseInt(body.maxUses, 10) : null,
      plans: JSON.stringify(Array.isArray(body.plans) ? [...new Set(body.plans.map(normalizePlan).filter(isPaidPlan))] : []),
      validUntil: body.validUntil || null,
      createdAt: new Date().toISOString(),
    });
    return json(res, { ok: true, code });
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/admin/promo-codes/')) {
    if (!isAdmin(req)) return json(res, { error: 'Unauthorized' }, 401);
    await deletePromoCode(decodeURIComponent(url.pathname.slice('/api/admin/promo-codes/'.length)));
    return json(res, { ok: true });
  }

  // ── Error log ──────────────────────────────────────────────────────────────
  if (req.method === 'GET' && url.pathname === '/api/admin/errors') {
    if (!isAdmin(req)) return json(res, { error: 'Unauthorized' }, 401);
    const search = (url.searchParams.get('search') || '').toLowerCase();
    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const pageSize = 50;
    let errors = await getAllErrors();
    if (search) errors = errors.filter(e => e.url.toLowerCase().includes(search) || (e.user_name || '').toLowerCase().includes(search) || (e.error_summary || '').toLowerCase().includes(search));
    const total = errors.length;
    const items = errors.slice((page - 1) * pageSize, page * pageSize).map(e => ({
      id: e.id, userId: e.user_id, userName: e.user_name, url: e.url,
      errorSummary: e.error_summary, logs: JSON.parse(e.logs || '[]'),
      startedAt: e.started_at, failedAt: e.failed_at,
    }));
    return json(res, { items, total, page, pageSize });
  }

  if (req.method === 'DELETE' && url.pathname.startsWith('/api/admin/errors/') && url.pathname !== '/api/admin/errors/') {
    if (!isAdmin(req)) return json(res, { error: 'Unauthorized' }, 401);
    await deleteError(url.pathname.slice('/api/admin/errors/'.length));
    return json(res, { ok: true });
  }

  if (req.method === 'DELETE' && url.pathname === '/api/admin/errors') {
    if (!isAdmin(req)) return json(res, { error: 'Unauthorized' }, 401);
    await clearErrors();
    return json(res, { ok: true });
  }

  // ── Google OAuth ──────────────────────────────────────────────────────────────

  if (req.method === 'GET' && url.pathname === '/api/auth/google') {
    const s = getCachedSettings();
    if (!s.google_client_id) return json(res, { error: 'Google OAuth not configured' }, 503);
    const state = randomUUID().replace(/-/g, '');
    _oauthStates.set(state, Date.now() + 10 * 60 * 1000); // 10 min
    const apiUrl = apiPublicUrl(req);
    const redirectUri = `${apiUrl}/api/auth/google/callback`;
    const params = new URLSearchParams({
      client_id: s.google_client_id,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'openid email profile',
      state,
      access_type: 'online',
      prompt: 'select_account',
    });
    res.writeHead(302, { Location: `https://accounts.google.com/o/oauth2/v2/auth?${params}` });
    res.end();
    return;
  }

  if (req.method === 'GET' && url.pathname === '/api/auth/google/callback') {
    const s = getCachedSettings();
    const apiUrl = apiPublicUrl(req);
    const frontend = frontendPublicUrl(req);
    const code = url.searchParams.get('code');
    const state = url.searchParams.get('state');
    const errParam = url.searchParams.get('error');
    if (errParam || !code || !state) { res.writeHead(302, { Location: `${frontend}/login?oauth_error=cancelled` }); res.end(); return; }
    if (!_oauthStates.has(state)) { res.writeHead(302, { Location: `${frontend}/login?oauth_error=invalid_state` }); res.end(); return; }
    _oauthStates.delete(state);
    try {
      const redirectUri = `${apiUrl}/api/auth/google/callback`;
      // Exchange code for tokens
      const tokenRes = await fetch('https://oauth2.googleapis.com/token', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ code, client_id: s.google_client_id, client_secret: s.google_client_secret || '', redirect_uri: redirectUri, grant_type: 'authorization_code' }),
      });
      if (!tokenRes.ok) throw new Error('token exchange failed');
      const { access_token } = await tokenRes.json();

      // Get user info
      const userInfoRes = await fetch('https://www.googleapis.com/oauth2/v3/userinfo', {
        headers: { Authorization: `Bearer ${access_token}` },
      });
      if (!userInfoRes.ok) throw new Error('userinfo failed');
      const gUser = await userInfoRes.json();
      const googleId = gUser.sub;
      const googleEmail = (gUser.email || '').toLowerCase().trim();
      const googleName = gUser.name || googleEmail.split('@')[0];

      // Find or create user
      let dbUser = await getUserByGoogleId(googleId);
      if (!dbUser && googleEmail) dbUser = await getUserByEmail(googleEmail);
      if (dbUser) {
        // Link google_id if not already linked
        if (!dbUser.google_id) await updateUser(dbUser.id, { google_id: googleId, email_verified: 1 });
      } else {
        // New user via Google
        const newId = randomUUID();
        await insertOAuthUser({ id: newId, name: googleName, email: googleEmail, googleId, createdAt: new Date().toISOString() });
        dbUser = await getUserById(newId);
        audit(newId, googleName, 'register_google', null, ip);
      }

      if (dbUser.blocked) {
        const reason = encodeURIComponent(await userBlockedReason(dbUser));
        res.writeHead(302, { Location: `${frontend}/login?oauth_error=blocked&ban_reason=${reason}` });
        res.end();
        return;
      }

      const sessionToken = randomUUID();
      await insertSession({ token: sessionToken, userId: dbUser.id, createdAt: new Date().toISOString(), expiresAt: Date.now() + 30*24*60*60*1000, impersonatedBy: null });
      audit(dbUser.id, dbUser.name, 'login_google', null, ip);

      res.writeHead(302, { Location: `${frontend}/dashboard?oauth_token=${sessionToken}` });
      res.end();
    } catch (err) {
      console.error('[Google OAuth]', err.message);
      res.writeHead(302, { Location: `${frontend}/login?oauth_error=server_error` });
      res.end();
    }
    return;
  }

  // ── Stripe ────────────────────────────────────────────────────────────────────

  // POST /api/payments/stripe/checkout — create a Stripe Checkout session
  if (req.method === 'POST' && url.pathname === '/api/payments/stripe/checkout') {
    const user = await getSessionUser(req);
    if (!user) return json(res, { error: 'Sign in first.' }, 401);
    const stripe = getStripe();
    if (!stripe) return json(res, { error: stripeUnavailableReason() || 'Stripe is not configured. Contact support.' }, 503);
    const checkoutBody = await readJsonBody(req);
    const plan = normalizePlan(checkoutBody.plan);
    const { interval, promoCode } = checkoutBody;
    if (!isPaidPlan(plan)) return json(res, { error: 'Invalid plan.' }, 400);
    const bi = interval === 'annual' ? 'annual' : 'monthly';
    let priceId = '';
    try {
      priceId = await ensureStripePrice(stripe, plan, bi);
    } catch (err) {
      return json(res, { error: `Stripe price setup failed: ${err.message}` }, 502);
    }
    const appUrl = publicAppUrl(req);

    let session;
    try {
      // Ensure Stripe customer exists
      let customerId = user.stripe_customer_id;
      if (!customerId) {
        const customer = await stripe.customers.create({ email: user.email, name: user.name, metadata: { userId: user.id } });
        customerId = customer.id;
        await updateUser(user.id, { stripe_customer_id: customerId });
      }

      // Validate promo code via Stripe if provided
      let discounts = undefined;
      if (promoCode) {
        try {
          const codes = await stripe.promotionCodes.list({ code: promoCode, active: true, limit: 1 });
          if (codes.data.length > 0) discounts = [{ promotion_code: codes.data[0].id }];
        } catch {}
      }

      session = await stripe.checkout.sessions.create({
        customer: customerId,
        client_reference_id: user.id,
        mode: 'subscription',
        line_items: [{ price: priceId, quantity: 1 }],
        allow_promotion_codes: !discounts,
        ...(discounts ? { discounts } : {}),
        metadata: { userId: user.id, plan, interval: bi },
        subscription_data: { metadata: { userId: user.id, plan, interval: bi } },
        success_url: `${appUrl}/dashboard?stripe=success&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${appUrl}/dashboard?stripe=cancelled`,
      });
    } catch (err) {
      return json(res, { error: `Stripe checkout failed: ${err.message}` }, 502);
    }
    audit(user.id, user.name, 'stripe_checkout_created', `plan=${plan} interval=${bi}`, ip);
    return json(res, { url: session.url });
  }

  // POST /api/payments/stripe/sync — immediately unlock paid access after Checkout
  if (req.method === 'POST' && url.pathname === '/api/payments/stripe/sync') {
    const user = await getSessionUser(req);
    if (!user) return json(res, { error: 'Not authenticated' }, 401);
    const stripe = getStripe();
    if (!stripe) return json(res, { error: stripeUnavailableReason() || 'Stripe not configured' }, 503);
    const { sessionId } = await readJsonBody(req).catch(() => ({}));
    try {
      let sub = null;
      let customerId = user.stripe_customer_id || '';
      if (sessionId) {
        const session = await stripe.checkout.sessions.retrieve(String(sessionId));
        if (session.client_reference_id !== user.id && session.metadata?.userId !== user.id) {
          return json(res, { error: 'Checkout session does not belong to this account.' }, 403);
        }
        if (session.customer && session.customer !== user.stripe_customer_id) {
          customerId = session.customer;
          await updateUser(user.id, { stripe_customer_id: customerId });
        }
        if (session.subscription) sub = await stripe.subscriptions.retrieve(session.subscription);
      }
      if (!sub && customerId) {
        const subs = await stripe.subscriptions.list({ customer: customerId, status: 'active', limit: 5 });
        sub = subs.data.find(s => s.metadata?.userId === user.id) || subs.data[0] || null;
      }
      if (!sub || !['active', 'trialing'].includes(sub.status)) {
        return json(res, { error: 'No active Stripe subscription found yet. Please wait a moment and refresh.' }, 404);
      }
      const plan = stripeSubscriptionPlan(sub, user.plan);
      if (!isPaidPlan(plan)) return json(res, { error: 'Could not identify the paid plan for this subscription.' }, 409);
      const periodEnd = stripePeriodEnd(sub);
      const renewsAt = periodEnd ? new Date(periodEnd * 1000) : null;
      const interval = sub.metadata?.interval || user.billing_interval || 'monthly';
      await activatePaidPlanForUser(user.id, {
        plan,
        interval,
        renewsAt,
        stripeSubscriptionId: sub.id,
        cancelAtPeriodEnd: sub.cancel_at_period_end ? 1 : 0,
      });
      audit(user.id, user.name, 'stripe_subscription_synced', `plan=${plan} subscription=${sub.id}`, ip);
      return json(res, { ok: true, user: userPublic(await getUserById(user.id)) });
    } catch (err) {
      return json(res, { error: `Stripe sync failed: ${err.message}` }, 502);
    }
  }

  // POST /api/payments/stripe/portal — billing portal for self-service
  if (req.method === 'POST' && url.pathname === '/api/payments/stripe/portal') {
    const user = await getSessionUser(req);
    if (!user) return json(res, { error: 'Not authenticated' }, 401);
    const stripe = getStripe();
    if (!stripe) return json(res, { error: stripeUnavailableReason() || 'Stripe not configured' }, 503);
    if (!user.stripe_customer_id) return json(res, { error: 'No Stripe subscription found' }, 400);
    const appUrl = publicAppUrl(req);
    try {
      const portal = await stripe.billingPortal.sessions.create({
        customer: user.stripe_customer_id,
        return_url: `${appUrl}/dashboard`,
      });
      return json(res, { url: portal.url });
    } catch (err) {
      return json(res, { error: `Stripe portal failed: ${err.message}` }, 502);
    }
  }

  // POST /api/stripe/webhook — Stripe event handler (requires raw body)
  if (req.method === 'POST' && url.pathname === '/api/stripe/webhook') {
    const stripe = getStripe();
    if (!stripe) { res.writeHead(503); res.end(stripeUnavailableReason() || 'Stripe not configured'); return; }
    const rawBody = await readRawBody(req);
    const sig = req.headers['stripe-signature'] || '';
    const s = getStripeSettings();
    if (!s.stripe_webhook_secret) { res.writeHead(503); res.end('Stripe webhook secret not configured'); return; }
    let event;
    try {
      event = stripe.webhooks.constructEvent(rawBody, sig, s.stripe_webhook_secret || '');
    } catch (err) {
      console.error('[Stripe webhook] signature verification failed:', err.message);
      try { await insertError({ id: randomUUID(), userId: null, userName: 'stripe-webhook', url: '/api/stripe/webhook', errorSummary: 'Signature verification failed: ' + err.message, logs: '[]', startedAt: new Date().toISOString(), failedAt: new Date().toISOString() }); await pruneErrors(); } catch {}
      res.writeHead(400); res.end('Invalid signature');
      return;
    }

    const appUrl = publicAppUrl(req);

    try {
      if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        if (session.payment_status === 'paid' && session.subscription) {
          const sub = await stripe.subscriptions.retrieve(session.subscription);
          const userId = sub.metadata?.userId || session.metadata?.userId;
          const plan = normalizePlan(sub.metadata?.plan || session.metadata?.plan);
          const bi = sub.metadata?.interval || session.metadata?.interval || 'monthly';
          if (userId && plan) {
            const periodEnd = stripePeriodEnd(sub);
            const renewsAt = periodEnd ? new Date(periodEnd * 1000) : new Date(Date.now() + (bi === 'annual' ? 365 : 31) * 24 * 60 * 60 * 1000);
            await activatePaidPlanForUser(userId, { plan, interval: bi, renewsAt, stripeSubscriptionId: sub.id, cancelAtPeriodEnd: sub.cancel_at_period_end ? 1 : 0 });
            const u = await getUserById(userId);
            if (u) {
              await insertPayment({ id: randomUUID(), userId, userName: u.name, userEmail: u.email, plan, amount: (session.amount_total || 0) / 100, currency: (session.currency || 'usd').toUpperCase(), method: 'stripe', txId: session.payment_intent || session.id, note: '', promoCode: null, discountPercent: 0, interval: bi, status: 'confirmed', submittedAt: new Date().toISOString() });
              sendEmail(u.email, `Payment confirmed — ${plan} plan activated`,
                renderEmail('payment-confirmed', { SUBJECT: `${plan} plan activated`, NAME: u.name, PLAN: plan, AMOUNT: String((session.amount_total || 0) / 100), INTERVAL: bi, RENEWS_AT: renewsAt.toLocaleDateString() })
              ).catch(() => {});
              audit(userId, u.name, 'stripe_payment_confirmed', `plan=${plan} amount=${(session.amount_total||0)/100}`, null);
            }
          }
        }
      }

      if (event.type === 'customer.subscription.updated') {
        const sub = event.data.object;
        const customerUser = sub.customer ? await getUserByStripeCustomerId(sub.customer) : null;
        const userId = sub.metadata?.userId || customerUser?.id;
        if (userId && sub.status === 'active') {
          const plan = stripeSubscriptionPlan(sub, customerUser?.plan);
          const bi = sub.metadata?.interval || customerUser?.billing_interval || 'monthly';
          const periodEnd = stripePeriodEnd(sub);
          const renewsAt = periodEnd ? new Date(periodEnd * 1000) : null;
          if (isPaidPlan(plan)) await activatePaidPlanForUser(userId, { plan, interval: bi, renewsAt, stripeSubscriptionId: sub.id, cancelAtPeriodEnd: sub.cancel_at_period_end ? 1 : 0 });
        }
      }

      if (event.type === 'invoice.payment_succeeded') {
        const inv = event.data.object;
        const customerId = inv.customer;
        const u = customerId ? await getUserByStripeCustomerId(customerId) : null;
        const subscriptionId = inv.subscription || inv.parent?.subscription_details?.subscription || null;
        if (u && subscriptionId) {
          const sub = await stripe.subscriptions.retrieve(subscriptionId);
          const plan = stripeSubscriptionPlan(sub, u.plan);
          const bi = sub.metadata?.interval || u.billing_interval || 'monthly';
          const periodEnd = stripePeriodEnd(sub);
          const renewsAt = periodEnd ? new Date(periodEnd * 1000) : null;
          await activatePaidPlanForUser(u.id, { plan, interval: bi, renewsAt, stripeSubscriptionId: sub.id, cancelAtPeriodEnd: sub.cancel_at_period_end ? 1 : 0 });
        }
      }

      if (event.type === 'customer.subscription.deleted') {
        const sub = event.data.object;
        const customerUser = sub.customer ? await getUserByStripeCustomerId(sub.customer) : null;
        const userId = sub.metadata?.userId || customerUser?.id;
        if (userId) {
          await updateUser(userId, { plan: 'free', plan_renews_at: null, stripe_subscription_id: null, cancel_at_period_end: 0, renewal_reminder_sent: 0, usage_alert_sent: 0 });
          _invalidateUserSessions(userId);
          const u = await getUserById(userId);
          if (u) {
            sendEmail(u.email, 'Your account has been downgraded to Free',
              renderEmail('downgraded', { SUBJECT: 'Account downgraded to Free', NAME: u.name })
            ).catch(() => {});
            audit(userId, u.name, 'stripe_subscription_deleted', null, null);
          }
        }
      }

      if (event.type === 'invoice.upcoming') {
        const inv = event.data.object;
        const customerId = inv.customer;
        const u = customerId ? await getUserByStripeCustomerId(customerId) : null;
        if (u && isPaidPlan(u.plan) && !u.renewal_reminder_sent) {
          const renewsAt = inv.period_end ? new Date(inv.period_end * 1000) : null;
          await updateUser(u.id, { renewal_reminder_sent: 1 });
          sendEmail(u.email, `Your CLONYFY ${getPlanLabel(u.plan)} plan renews soon`,
            renderEmail('renewal-reminder', {
              SUBJECT: `Your ${getPlanLabel(u.plan)} plan renews soon`,
              NAME: u.name, PLAN: getPlanLabel(u.plan),
              EXPIRED_AT: renewsAt ? renewsAt.toLocaleDateString() : 'soon',
            })
          ).catch(() => {});
          audit(u.id, u.name, 'stripe_renewal_reminder', `invoice=${inv.id}`, null);
        }
      }

      if (event.type === 'invoice.payment_failed') {
        const inv = event.data.object;
        const customerId = inv.customer;
        const u = customerId ? await getUserByStripeCustomerId(customerId) : null;
        if (u) {
          // Record failed payment so it appears in billing history
          await insertPayment({
            id: randomUUID(), userId: u.id, userName: u.name, userEmail: u.email,
            plan: normalizePlan(u.plan), amount: (inv.amount_due || 0) / 100,
            currency: (inv.currency || 'usd').toUpperCase(),
            method: 'stripe', txId: inv.payment_intent || inv.id,
            note: 'Payment failed', promoCode: null, discountPercent: 0,
            interval: u.billing_interval || 'monthly', status: 'failed',
            submittedAt: new Date().toISOString(),
          }).catch(() => {});
          let portalUrl = appUrl + '/dashboard';
          try {
            const portal = await stripe.billingPortal.sessions.create({ customer: customerId, return_url: appUrl + '/dashboard' });
            portalUrl = portal.url;
          } catch {}
          sendEmail(u.email, 'Payment failed — action required',
            renderEmail('payment-failed', { SUBJECT: 'Payment failed', NAME: u.name, PLAN: getPlanLabel(u.plan), PORTAL_URL: portalUrl })
          ).catch(() => {});
          audit(u.id, u.name, 'stripe_payment_failed', `invoice=${inv.id}`, null);
        }
      }
    } catch (err) {
      console.error('[Stripe webhook handler]', err.message);
      try { await insertError({ id: randomUUID(), userId: null, userName: 'stripe-webhook', url: '/api/stripe/webhook', errorSummary: 'Webhook handler error: ' + err.message, logs: '[]', startedAt: new Date().toISOString(), failedAt: new Date().toISOString() }); await pruneErrors(); } catch {}
      // 500 so Stripe RETRIES the event. Returning 200 here meant a transient
      // DB failure during checkout.session.completed left a paying customer
      // without their plan, permanently — Stripe never resends acked events.
      res.writeHead(500); res.end('handler error');
      return;
    }

    res.writeHead(200); res.end('ok');
    return;
  }

  // robots.txt
  if (req.method === 'GET' && url.pathname === '/robots.txt') {
    const host = publicAppUrl(req);
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end(`User-agent: *\nDisallow: /api/\nDisallow: /admin\nDisallow: /dashboard\nDisallow: /share/\nSitemap: ${host}/sitemap.xml\n`);
    return;
  }

  // sitemap.xml
  if (req.method === 'GET' && url.pathname === '/sitemap.xml') {
    const host = publicAppUrl(req);
    const now = new Date().toISOString().split('T')[0];
    res.writeHead(200, { 'Content-Type': 'application/xml' });
    const urls = [
      { loc: `${host}/`,           changefreq: 'weekly',  priority: '1.0' },
      { loc: `${host}/app`,        changefreq: 'monthly', priority: '0.8' },
      { loc: `${host}/privacy`,    changefreq: 'monthly', priority: '0.3' },
      { loc: `${host}/tos`,        changefreq: 'monthly', priority: '0.3' },
    ];
    const urlset = urls.map(u => `<url><loc>${u.loc}</loc><lastmod>${now}</lastmod><changefreq>${u.changefreq}</changefreq><priority>${u.priority}</priority></url>`).join('');
    res.end(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urlset}</urlset>`);
    return;
  }

  // ── Deploy to Netlify ────────────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/deploy/netlify') {
    const deployUser = await getSessionUser(req);
    if (!deployUser) return json(res, { error: 'Not authenticated' }, 401);
    if (!isPaidPlan(deployUser.plan)) return json(res, { error: 'Deploy requires a paid plan. Upgrade to deploy your clones.' }, 403);
    let body; try { body = await readJsonBody(req); } catch { return json(res, { error: 'Bad request' }, 400); }
    const { outDir: rawOutDir, netlifyToken } = body;
    if (!netlifyToken) return json(res, { error: 'Netlify personal access token is required' }, 400);
    const outDir = resolveCloneOutDir(rawOutDir);
    if (!outDir) return json(res, { error: 'Invalid output folder' }, 400);
    if (!await canUseCloneOutput(deployUser, outDir)) return json(res, { error: 'Not found' }, 404);

    const deployTmp = join(OUTPUT_DIR, `__deploy_${randomUUID().slice(0,8)}`);
    const zipPath = deployTmp + '.zip';
    let materialized = null;
    try {
      materialized = await materializeCloneOutput(outDir);
      mkdirSync(deployTmp, { recursive: true });
      const routeMapPath = join(materialized.dir, 'route-map.json');
      const capturedPagesDir = join(materialized.dir, 'captured-pages');
      const assetsDir = join(materialized.dir, 'public', '_assets');

      if (existsSync(routeMapPath) && existsSync(capturedPagesDir)) {
        const routeMap = JSON.parse(readFileSync(routeMapPath, 'utf8'));
        for (const [route, filename] of Object.entries(routeMap)) {
          let cleanFilename;
          try { cleanFilename = normalizeCloneRelPath(join('captured-pages', String(filename)), ['captured-pages']).slice('captured-pages/'.length); }
          catch { continue; }
          const srcPath = join(capturedPagesDir, cleanFilename);
          if (!existsSync(srcPath)) continue;
          const destPath = join(deployTmp, routeToStaticPath(route));
          if (!isInsideDir(deployTmp, destPath)) continue;
          mkdirSync(dirname(destPath), { recursive: true });
          copyFileSync(srcPath, destPath);
        }
      } else if (existsSync(capturedPagesDir)) {
        for (const f of readdirSync(capturedPagesDir)) {
          if (f.endsWith('.html')) copyFileSync(join(capturedPagesDir, f), join(deployTmp, f));
        }
      }

      if (existsSync(assetsDir)) {
        const destAssets = join(deployTmp, '_assets');
        mkdirSync(destAssets, { recursive: true });
        for (const f of readdirSync(assetsDir)) copyFileSync(join(assetsDir, f), join(destAssets, f));
      }

      // Use the same cross-platform pure-JS zipper as /api/download-zip so the
      // deploy artifact is a real PKZIP on every host.
      await createCrossPlatformZip(deployTmp, zipPath);

      const zipData = readFileSync(zipPath);

      const siteResp = await netlifyAPIRequest('POST', '/api/v1/sites', netlifyToken, JSON.stringify({}), 'application/json');
      if (siteResp.status >= 400) return json(res, { error: siteResp.body.message || `Netlify: ${siteResp.status}` }, 502);
      const siteId = siteResp.body.id;
      const subdomain = siteResp.body.subdomain;

      const deployResp = await netlifyAPIRequest('POST', `/api/v1/sites/${siteId}/deploys`, netlifyToken, zipData, 'application/zip');
      if (deployResp.status >= 400) return json(res, { error: deployResp.body.message || `Deploy failed: ${deployResp.status}` }, 502);

      const siteUrl = deployResp.body.deploy_ssl_url || deployResp.body.url || `https://${subdomain}.netlify.app`;
      return json(res, { ok: true, url: siteUrl, siteId });
    } catch(err) {
      return json(res, { error: err.message }, 500);
    } finally {
      if (materialized) materialized.cleanup();
      try { rmSync(deployTmp, { recursive: true, force: true }); } catch {}
      try { rmSync(zipPath); } catch {}
    }
  }

  // ── Support contact ────────────────────────────────────────────────────────
  if (req.method === 'POST' && url.pathname === '/api/support/contact') {
    if (!checkRateLimit(`support:${ip}`, 3, 3600000)) return json(res, { error: 'Too many requests. Try again later.' }, 429);
    const body = await readJsonBody(req);
    const cleanName = String(body.name || '').trim().slice(0, 80);
    const cleanLastName = String(body.lastName || body.lastname || '').trim().slice(0, 80);
    const cleanPhone = String(body.phone || '').trim().slice(0, 60);
    const cleanEmail = String(body.email || body.mail || '').trim().slice(0, 120);
    const cleanMessage = String(body.message || '').trim().slice(0, 2000);
    if (!cleanName || !cleanLastName || !cleanPhone || !cleanEmail || !cleanMessage) {
      return json(res, { error: 'Name, lastname, phone, mail, and message are required.' }, 400);
    }
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) return json(res, { error: 'Invalid email.' }, 400);

    await insertContactSubmission({
      id: randomUUID(),
      name: cleanName,
      lastName: cleanLastName,
      phone: cleanPhone,
      email: cleanEmail,
      message: cleanMessage,
      ip,
      userAgent: String(req.headers['user-agent'] || '').slice(0, 300),
      createdAt: new Date().toISOString(),
    });

    const s = getCachedSettings();
    const supportEmail = s.support_email || s.smtp_from || '';
    if (supportEmail) {
      const fullName = `${cleanName} ${cleanLastName}`.trim();
      const subject = `Contact form: ${fullName}`;
      const body = renderEmail('support-contact', {
        SUBJECT: subject,
        FROM_NAME: fullName,
        FROM_EMAIL: cleanEmail,
        MESSAGE: `Phone: ${htmlEsc(cleanPhone)}<br><br>${htmlEsc(cleanMessage).replace(/\n/g, '<br>')}`,
      });
      sendEmail(supportEmail, subject, body).catch(() => {});
    }
    audit(null, `${cleanName} ${cleanLastName}`.trim(), 'support_contact', `email=${cleanEmail}`, ip);
    return json(res, { ok: true });
  }

  // admin security check
  if (req.method === 'GET' && url.pathname === '/api/admin/security') {
    if (!isAdmin(req)) return json(res, { error: 'Unauthorized' }, 401);
    return json(res, {
      adminPasswordSet: !!ADMIN_PASSWORD,
      smtpConfigured: !!(getCachedSettings().smtp_host),
      stripeConfigured: !!(getStripeSettings().stripe_secret_key),
      stripeError: stripeUnavailableReason(),
      appUrlConfigured: !!(getCachedSettings().app_url),
    });
  }

  // Preview-asset fallback: when a cloned page references an absolute path
  // (e.g. /figma/abc.svg, /assets/img/foo.png, /video.mp4, /api/foo.php)
  // that we didn't capture, transparently redirect to the original site so
  // the preview still shows the asset. Uses Referer to find which clone is
  // being viewed. Handles GET, HEAD, and POST (cloned JS often POSTs to APIs).
  if (req.method === 'GET' || req.method === 'HEAD' || req.method === 'POST') {
    try {
      const refOutDir = await previewOutDirFromReferer(req);
      if (refOutDir) {
        // Quiet telemetry beacons the cloned site fires (Cloudflare RUM,
        // analytics) — return 204 so the console isn't flooded with 404s.
        if (/^\/(cdn-cgi\/|__cf|gtm|gtag|gtag-rum|googletagmanager|hotjar|segment\.io|amplitude|mixpanel|fathom|plausible|posthog)/i.test(url.pathname)) {
          res.writeHead(204);
          res.end();
          return;
        }
        const manifestData = await readCloneFile(refOutDir, 'manifest.json').catch(() => null);
        if (manifestData) {
          const manifest = safeJsonParse(manifestData.toString('utf8'), null);
          const targetOrigin = String(manifest?.targetOrigin || '').replace(/\/$/, '');
          if (targetOrigin && /^https?:\/\//.test(targetOrigin)) {
            const redirectTo = targetOrigin + url.pathname + (url.search || '');
            // 307/308 preserve method+body (302 may downgrade POST→GET).
            const status = (req.method === 'POST') ? 307 : 302;
            res.writeHead(status, { Location: redirectTo, 'Cache-Control': 'public, max-age=300' });
            res.end();
            return;
          }
        }
      }
    } catch {}
  }

  return json(res, { error: 'Not found' }, 404);
}

let _initialized = false;
async function ensureInit() {
  if (_initialized) return;
  _initialized = true;

  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    console.warn('[WARN] SUPABASE_URL or SUPABASE_SERVICE_KEY is not set — clone history and user accounts will not be persisted.');
  } else {
    try {
      await getAllUsers();
    } catch (dbErr) {
      console.error(`[WARN] Supabase is unreachable (${dbErr?.message || dbErr}) — clone history and user accounts will not be persisted.`);
    }
  }

  await initSettings();
  runDunning().catch(() => {});
  setInterval(runDunning, 3600000);
}

async function handler(req, res) {
  try {
    await ensureInit();
    return await handleRequest(req, res);
  } catch (err) {
    // Client-input errors thrown by body readers should be 4xx, not 500 —
    // a malformed JSON body or oversized payload is the caller's fault and
    // shouldn't look like a server outage in logs or to the UI.
    const msg = err?.message || '';
    if (!res.headersSent && msg === 'bad json') return json(res, { error: 'Invalid JSON in request body' }, 400);
    if (!res.headersSent && (msg === 'request too large' || msg === 'too large')) return json(res, { error: 'Request body too large' }, 413);
    console.error('[REQUEST ERROR]', msg || err, err?.stack || '');
    if (!res.headersSent) {
      return json(res, { error: 'Internal server error' }, 500);
    }
    try { res.end(); } catch {}
  }
}

process.on('warning', (w) => {
  if (w?.name === 'MaxListenersExceededWarning') return;
  console.warn(`[process] ${w?.name || 'Warning'}: ${w?.message || w}`);
});

ensureInit().then(() => {
  // Bind all interfaces so Render/proxy health checks can reach the process.
  createServer(handler).listen(PORT, '0.0.0.0', () => {
    const publicUrl = DEFAULT_APP_URL || `http://localhost:${PORT}`;
    console.log(`\nCLONYFY API listening on 0.0.0.0:${PORT}`);
    console.log(`Public URL: ${publicUrl}`);
    console.log(`Frontend CORS: ${process.env.FRONTEND_URL || process.env.PUBLIC_APP_URL || '(not set)'}`);
    console.log(
      `Hosted=${IS_HOSTED} lowMemory=${IS_LOW_MEMORY} cloneConcurrency=${CLONE_CONCURRENCY} deadlineMs=${CLONE_DEADLINE_MS}\n`,
    );
  });
});

export default handler;
