import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';

let _supabase = null;
function getSupabase() {
  if (_supabase) return _supabase;
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    throw new Error('Missing SUPABASE_URL or SUPABASE_SERVICE_KEY environment variables');
  }
  _supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY,
    { auth: { persistSession: false } }
  );
  return _supabase;
}

const supabase = new Proxy({}, {
  get(_target, prop) {
    return getSupabase()[prop];
  },
});

// ── Helpers ───────────────────────────────────────────────────────────────────

async function one(query) {
  const { data, error } = await query.maybeSingle();
  if (error && error.code !== 'PGRST116') console.error('[DB one]', error.message);
  return data || null;
}

async function all(query) {
  const { data, error } = await query;
  if (error) console.error('[DB all]', error.message);
  return data || [];
}

// ── Users ─────────────────────────────────────────────────────────────────────

export const getUserById = (id) =>
  one(supabase.from('users').select('*').eq('id', id));

export const getUserByEmail = (email) =>
  one(supabase.from('users').select('*').eq('email', email));

export const getAllUsers = () =>
  all(supabase.from('users').select('*').order('created_at', { ascending: false }));

export const getUsersPage = async ({ search = '', plan = '', blocked = null, limit = 50, offset = 0 } = {}) => {
  let query = supabase.from('users').select('*', { count: 'exact' }).order('created_at', { ascending: false });
  // PostgREST .or() parses commas/parens as filter syntax — strip them so a
  // search like "Smith, John" can't break (or inject into) the filter string.
  const safeSearch = String(search).replace(/[,()]/g, ' ').trim();
  if (safeSearch) query = query.or(`name.ilike.%${safeSearch}%,email.ilike.%${safeSearch}%`);
  const planAliases = { growth: ['growth', 'pro'], unlimited: ['unlimited', 'enterprise'] };
  if (plan) {
    const plans = planAliases[plan] || [plan];
    query = plans.length > 1 ? query.in('plan', plans) : query.eq('plan', plan);
  }
  if (blocked === true) query = query.eq('blocked', 1);
  if (blocked === false) query = query.eq('blocked', 0);
  query = query.range(offset, offset + limit - 1);
  const { data, error, count } = await query;
  if (error) throw new Error(error.message);
  return { users: data || [], total: count || 0 };
};

export const getClonesByUserIds = (userIds) =>
  userIds.length === 0 ? Promise.resolve([]) :
  all(supabase.from('clones').select('user_id, started_at').in('user_id', userIds).order('started_at', { ascending: false }));

export const insertUser = async (u) => {
  const { error } = await supabase.from('users').insert({
    id: u.id, name: u.name, email: u.email, hash: u.hash || '',
    salt: u.salt || null, plan: 'free', email_verified: 0,
    verify_token: u.verifyToken || null, verify_expiry: u.verifyExpiry || null,
    created_at: u.createdAt,
  });
  if (error) throw new Error(error.message);
};

export const updateUser = async (id, fields) => {
  const allowed = [
    'name','email','hash','salt','plan','plan_renews_at','billing_interval',
    'email_verified','verify_token','verify_expiry','reset_token','reset_expiry',
    'blocked','blocked_reason','cancel_at_period_end','renewal_reminder_sent','usage_alert_sent',
    'google_id','stripe_customer_id','stripe_subscription_id',
  ];
  const update = {};
  for (const [k, v] of Object.entries(fields)) {
    if (allowed.includes(k)) update[k] = v;
  }
  if (!Object.keys(update).length) return;
  const { error } = await supabase.from('users').update(update).eq('id', id);
  if (error && update.blocked_reason !== undefined && /blocked_reason/i.test(error.message || '')) {
    delete update.blocked_reason;
    if (!Object.keys(update).length) return;
    const retry = await supabase.from('users').update(update).eq('id', id);
    if (retry.error) throw new Error(retry.error.message);
    return;
  }
  if (error) throw new Error(error.message);
};

export const deleteUser = async (id) => {
  await supabase.from('users').delete().eq('id', id);
};

export const getUserByVerifyToken = (token, now) =>
  one(supabase.from('users').select('*').eq('verify_token', token).gt('verify_expiry', now));

export const getUserByResetToken = (token, now) =>
  one(supabase.from('users').select('*').eq('reset_token', token).gt('reset_expiry', now));

export const getUserByGoogleId = (googleId) =>
  one(supabase.from('users').select('*').eq('google_id', googleId));

export const getUserByStripeCustomerId = (customerId) =>
  one(supabase.from('users').select('*').eq('stripe_customer_id', customerId));

export const insertOAuthUser = async (u) => {
  const { error } = await supabase.from('users').insert({
    id: u.id, name: u.name, email: u.email, hash: '', salt: null,
    plan: 'free', email_verified: 1, google_id: u.googleId,
    verify_token: null, verify_expiry: null, created_at: u.createdAt,
  });
  if (error) throw new Error(error.message);
};

// ── Sessions ──────────────────────────────────────────────────────────────────

export const getSession = (token) =>
  one(supabase.from('sessions').select('*').eq('token', token));

export const insertSession = async (s) => {
  const { error } = await supabase.from('sessions').insert({
    token: s.token, user_id: s.userId, created_at: s.createdAt,
    expires_at: s.expiresAt, impersonated_by: s.impersonatedBy || null,
  });
  if (error) throw new Error(error.message);
};

export const deleteSession = async (token) => {
  await supabase.from('sessions').delete().eq('token', token);
};

export const deleteUserSessions = async (userId) => {
  await supabase.from('sessions').delete().eq('user_id', userId);
};

export const cleanExpiredSessions = async (now) => {
  await supabase.from('sessions').delete().lt('expires_at', now);
};

// ── Clones ────────────────────────────────────────────────────────────────────

export const insertClone = async (c) => {
  const { error } = await supabase.from('clones').upsert({
    id: c.id, user_id: c.userId, user_name: c.userName, url: c.url,
    out_dir: c.outDir, status: c.status, pages: c.pages ?? null,
    assets: c.assets ?? null, api_routes: c.apiRoutes ?? null,
    started_at: c.startedAt, completed_at: c.completedAt ?? null,
  });
  if (error) throw new Error(error.message);
};

export const updateCloneLabel = async ({ id, label }) => {
  await supabase.from('clones').update({ label: label ?? null }).eq('id', id);
};

export const updateCloneStatus = async ({ id, status, pages, assets, apiRoutes, completedAt }) => {
  const update = {};
  if (status !== undefined) update.status = status;
  if (pages !== undefined) update.pages = pages;
  if (assets !== undefined) update.assets = assets;
  if (apiRoutes !== undefined) update.api_routes = apiRoutes;
  if (completedAt !== undefined) update.completed_at = completedAt;
  if (!Object.keys(update).length) return;
  const { error } = await supabase.from('clones').update(update).eq('id', id);
  if (error) throw new Error(error.message);
};

export const getClonesByUser = (userId, limit = null) => {
  let query = supabase.from('clones').select('*').eq('user_id', userId).order('started_at', { ascending: false });
  if (limit) query = query.limit(limit);
  return all(query);
};

export const getAllClones = () =>
  all(supabase.from('clones').select('*').order('started_at', { ascending: false }));

export const getCloneByOutDir = (outDir) =>
  one(supabase.from('clones').select('*').eq('out_dir', outDir));

export const deleteCloneById = async (id) => {
  await supabase.from('clones').delete().eq('id', id);
};

export const deleteUserClones = async (userId) => {
  await supabase.from('clones').delete().eq('user_id', userId);
};

// Aggregate stats for admin dashboard — avoids loading entire tables.
export const getAdminStats = async () => {
  const monthStart = new Date(); monthStart.setDate(1); monthStart.setHours(0, 0, 0, 0);
  const [
    { count: totalUsers },
    { count: blockedUsers },
    { count: totalClones },
    { count: totalErrors },
    { count: pendingPayments },
    { data: paidUsers },
    { data: confirmedPayments },
  ] = await Promise.all([
    supabase.from('users').select('*', { count: 'exact', head: true }),
    supabase.from('users').select('*', { count: 'exact', head: true }).eq('blocked', 1),
    supabase.from('clones').select('*', { count: 'exact', head: true }),
    supabase.from('errors').select('*', { count: 'exact', head: true }),
    supabase.from('payments').select('*', { count: 'exact', head: true }).eq('status', 'pending'),
    supabase.from('users').select('plan, billing_interval, plan_renews_at').neq('plan', 'free'),
    supabase.from('payments').select('amount, processed_at').eq('status', 'confirmed'),
  ]);
  const now = new Date();
  const activePaidUsers = (paidUsers || []).filter(u => u.plan_renews_at && new Date(u.plan_renews_at) > now);
  const confirmed = confirmedPayments || [];
  const totalRevenue = confirmed.reduce((s, p) => s + (p.amount || 0), 0);
  const monthRevenue = confirmed.filter(p => new Date(p.processed_at) >= monthStart).reduce((s, p) => s + (p.amount || 0), 0);
  return { totalUsers: totalUsers || 0, blockedUsers: blockedUsers || 0, totalClones: totalClones || 0, totalErrors: totalErrors || 0, pendingPayments: pendingPayments || 0, activePaidUsers, totalRevenue, monthRevenue };
};

export const getCloneCountThisMonth = async (userId, monthStart) => {
  const { count } = await supabase.from('clones')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .gte('started_at', monthStart);
  return count || 0;
};

// ── Payments ──────────────────────────────────────────────────────────────────

export const getAllPayments = () =>
  all(supabase.from('payments').select('*').order('submitted_at', { ascending: false }));

export const getPaymentsByUser = (userId) =>
  all(supabase.from('payments').select('*').eq('user_id', userId).order('submitted_at', { ascending: false }));

export const getPaymentById = (id) =>
  one(supabase.from('payments').select('*').eq('id', id));

export const insertPayment = async (p) => {
  const { error } = await supabase.from('payments').insert({
    id: p.id, user_id: p.userId, user_name: p.userName, user_email: p.userEmail,
    plan: p.plan, amount: p.amount, currency: p.currency, method: p.method,
    tx_id: p.txId, note: p.note, promo_code: p.promoCode,
    discount_percent: p.discountPercent, interval: p.interval,
    status: p.status, submitted_at: p.submittedAt,
  });
  if (error) throw new Error(error.message);
};

export const updatePayment = async ({ id, status, processedAt, reason }) => {
  const { error } = await supabase.from('payments').update({ status, processed_at: processedAt, reason }).eq('id', id);
  if (error) throw new Error(error.message); // silent failure left payments stuck "pending" after admin confirmed them
};

export const getPendingPaymentByUserPlan = (userId, plan, status) =>
  one(supabase.from('payments').select('*').eq('user_id', userId).eq('plan', plan).eq('status', status));

// ── Settings ──────────────────────────────────────────────────────────────────

export const getSetting = async (key) => {
  const { data } = await supabase.from('settings').select('value').eq('key', key).maybeSingle();
  return data;
};

export const setSetting = async (key, value) => {
  await supabase.from('settings').upsert({ key, value });
};

const SETTINGS_DEFAULTS = {
  btc:'', eth:'', usdt_trc20:'', paypal_email:'', paypal_me:'', app_note:'',
  smtp_host:'', smtp_port:'587', smtp_user:'', smtp_pass:'', smtp_from:'',
  smtp_secure:'false', app_url:(process.env.APP_URL || (process.env.VERCEL_URL ? `https://${process.env.VERCEL_URL}` : '') || 'http://localhost:5000').replace(/\/$/, ''),
  affiliate_enabled:'true', affiliate_program_url:'https://affonso.io/', affiliate_public_id:'cmpj1i5tn00087mxngp80ddzy',
  affiliate_program_id:'', affiliate_group_id:'', affiliate_api_key:'',
};

export async function getSettings() {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    return { ...SETTINGS_DEFAULTS, smtp_secure: false };
  }
  const { data } = await supabase.from('settings').select('key,value');
  const result = { ...SETTINGS_DEFAULTS };
  for (const { key, value } of (data || [])) result[key] = value;
  result.smtp_secure = result.smtp_secure === 'true';
  return result;
}

export async function saveSettings(obj) {
  const rows = Object.entries(obj).map(([key, value]) => ({ key, value: String(value ?? '') }));
  const { error } = await supabase.from('settings').upsert(rows, { onConflict: 'key' });
  if (error) throw new Error(error.message);
}

const affiliateReferralKey = (ownerId) => `affiliate_referrals:${ownerId}`;
const affiliateVisitKey = (ownerId) => `affiliate_visits:${ownerId}`;
const affiliateSlugKey = (slug) => `affiliate_slug:${slug}`;

export async function getAffiliateOwnerBySlug(slug) {
  const clean = String(slug || '').trim().toLowerCase();
  if (!clean) return null;
  const { data } = await supabase.from('settings').select('value').eq('key', affiliateSlugKey(clean)).maybeSingle();
  return data?.value || null;
}

export async function saveAffiliateSlug(slug, ownerId) {
  const clean = String(slug || '').trim().toLowerCase();
  if (!clean || !ownerId) return;
  await supabase.from('settings').upsert({ key: affiliateSlugKey(clean), value: String(ownerId) }, { onConflict: 'key' });
}

export async function getAffiliateReferrals(ownerId) {
  const { data } = await supabase.from('settings').select('value').eq('key', affiliateReferralKey(ownerId)).maybeSingle();
  try { return JSON.parse(data?.value || '[]'); } catch { return []; }
}

export async function addAffiliateReferral(ownerId, referral) {
  if (!ownerId || !referral?.userId || ownerId === referral.userId) return;
  const rows = await getAffiliateReferrals(ownerId);
  if (!rows.some(r => r.userId === referral.userId)) {
    rows.unshift({ ...referral, createdAt: referral.createdAt || new Date().toISOString(), status: referral.status || 'Signed up' });
    await supabase.from('settings').upsert({ key: affiliateReferralKey(ownerId), value: JSON.stringify(rows.slice(0, 500)) }, { onConflict: 'key' });
  }
}

export async function getAffiliateVisits(ownerId) {
  const { data } = await supabase.from('settings').select('value').eq('key', affiliateVisitKey(ownerId)).maybeSingle();
  try { return JSON.parse(data?.value || '[]'); } catch { return []; }
}

export async function addAffiliateVisit(ownerId, visit) {
  if (!ownerId || !visit?.visitorId) return;
  const rows = await getAffiliateVisits(ownerId);
  const recentCutoff = Date.now() - 24 * 60 * 60 * 1000;
  const existsRecent = rows.some(r => r.visitorId === visit.visitorId && new Date(r.createdAt || 0).getTime() > recentCutoff);
  if (!existsRecent) {
    rows.unshift({ ...visit, createdAt: visit.createdAt || new Date().toISOString() });
    await supabase.from('settings').upsert({ key: affiliateVisitKey(ownerId), value: JSON.stringify(rows.slice(0, 1000)) }, { onConflict: 'key' });
  }
}

const blockedReasonKey = (userId) => `blocked_reason:${userId}`;

export const getUserBlockReason = async (userId) => {
  const { data } = await supabase.from('settings').select('value').eq('key', blockedReasonKey(userId)).maybeSingle();
  return data?.value || '';
};

export const getUserBlockReasons = async (userIds = []) => {
  const keys = userIds.map(blockedReasonKey);
  if (!keys.length) return {};
  const { data, error } = await supabase.from('settings').select('key,value').in('key', keys);
  if (error) return {};
  const out = {};
  for (const row of data || []) out[row.key.replace(/^blocked_reason:/, '')] = row.value || '';
  return out;
};

export const setUserBlockReason = async (userId, reason) => {
  await supabase.from('settings').upsert({ key: blockedReasonKey(userId), value: String(reason || '') });
};

// ── Shares ────────────────────────────────────────────────────────────────────

export const getShare = (id) =>
  one(supabase.from('shares').select('*').eq('id', id));

export const insertShare = async (s) => {
  const { error } = await supabase.from('shares').insert({
    id: s.id, out_dir: s.outDir, route: s.route,
    created_at: s.createdAt, password_hash: s.passwordHash,
    salt: s.salt, expires_at: s.expiresAt ?? null,
  });
  // Must throw: if this silently fails, /api/share/create hands the user a
  // share URL that 404s for everyone they send it to.
  if (error) throw new Error(error.message);
};

export const deleteShare = async (id) => {
  await supabase.from('shares').delete().eq('id', id);
};

// ── Usage events (edit / save / share quotas) ─────────────────────────────────

let warnedUsageEventsMissing = false;

function isMissingUsageEventsTable(error) {
  const msg = String(error?.message || error || '').toLowerCase();
  return msg.includes('usage_events')
    && (msg.includes('schema cache') || msg.includes('does not exist') || msg.includes('relation'));
}

function warnUsageEventsMissing() {
  if (warnedUsageEventsMissing) return;
  warnedUsageEventsMissing = true;
  console.warn('[db] usage_events table missing — quotas not tracked until npm run db:migrate');
}

export const insertUsageEvent = async (e) => {
  const { error } = await supabase.from('usage_events').insert({
    id: e.id,
    user_id: e.userId,
    kind: e.kind,
    out_dir: e.outDir ?? null,
    created_at: e.createdAt,
  });
  if (error) {
    if (isMissingUsageEventsTable(error)) { warnUsageEventsMissing(); return; }
    throw new Error(error.message);
  }
};

export const countUsageEventsSince = async (userId, kind, sinceIso) => {
  const { count, error } = await supabase.from('usage_events')
    .select('*', { count: 'exact', head: true })
    .eq('user_id', userId)
    .eq('kind', kind)
    .gte('created_at', sinceIso);
  if (error) {
    if (isMissingUsageEventsTable(error)) { warnUsageEventsMissing(); return 0; }
    throw new Error(error.message);
  }
  return count || 0;
};

// ── Promo codes ───────────────────────────────────────────────────────────────

export const getAllPromoCodes = () =>
  all(supabase.from('promo_codes').select('*').order('created_at', { ascending: false }));

export const getPromoCode = (code) =>
  one(supabase.from('promo_codes').select('*').eq('code', code));

export const insertPromoCode = async (c) => {
  const { error } = await supabase.from('promo_codes').insert({
    code: c.code, discount_percent: c.discountPercent, description: c.description,
    max_uses: c.maxUses, used_count: 0, plans: c.plans,
    valid_until: c.validUntil, created_at: c.createdAt,
  });
  if (error) throw new Error(error.message); // admin saw "created" even when the code was never saved
};

export const incrementPromoUsed = async (code) => {
  const { data } = await supabase.from('promo_codes').select('used_count').eq('code', code).maybeSingle();
  if (data) await supabase.from('promo_codes').update({ used_count: (data.used_count || 0) + 1 }).eq('code', code);
};

export const deletePromoCode = async (code) => {
  await supabase.from('promo_codes').delete().eq('code', code);
};

// ── Errors ────────────────────────────────────────────────────────────────────

export const getAllErrors = () =>
  all(supabase.from('errors').select('*').order('failed_at', { ascending: false }));

export const insertError = async (e) => {
  await supabase.from('errors').upsert({
    id: e.id, user_id: e.userId, user_name: e.userName, url: e.url,
    error_summary: e.errorSummary, logs: e.logs,
    started_at: e.startedAt, failed_at: e.failedAt,
  });
};

export const deleteError = async (id) => {
  await supabase.from('errors').delete().eq('id', id);
};

export const clearErrors = async () => {
  await supabase.from('errors').delete().neq('id', '');
};

export const pruneErrors = async () => {
  const { data } = await supabase.from('errors')
    .select('id')
    .order('failed_at', { ascending: false })
    .range(2000, 999999);
  if (data && data.length > 0) {
    await supabase.from('errors').delete().in('id', data.map(e => e.id));
  }
};

// ── Audit log ─────────────────────────────────────────────────────────────────

export const insertAudit = async (a) => {
  await supabase.from('audit_log').insert({
    user_id: a.userId, user_name: a.userName, action: a.action,
    details: a.details, ip: a.ip, created_at: a.createdAt,
  });
};

export const getAuditLog = async (limit, offset) => {
  const { data } = await supabase.from('audit_log')
    .select('*')
    .order('id', { ascending: false })
    .range(offset, offset + limit - 1);
  return data || [];
};

// Unlike errors (pruned to 2000 on every insert) and sessions (pruned hourly),
// audit_log had no cap at all — it logs every login/clone/admin action
// forever, which is the most likely cause of an unbounded-growth Supabase
// storage warning on a long-running install. Called on the same hourly timer
// as session cleanup. Keeps the most recent 5000 rows.
export const pruneAuditLog = async () => {
  const { data } = await supabase.from('audit_log')
    .select('id')
    .order('id', { ascending: false })
    .range(5000, 999999);
  if (data && data.length > 0) {
    await supabase.from('audit_log').delete().in('id', data.map(r => r.id));
  }
};

export const getAuditCount = async () => {
  const { count } = await supabase.from('audit_log').select('*', { count: 'exact', head: true });
  return { c: count || 0 };
};

// ── Announcements ─────────────────────────────────────────────────────────────

export const insertAnnouncement = async (a) => {
  await supabase.from('announcements').insert({
    id: a.id, title: a.title, body: a.body, sent_to: a.sentTo,
    recipient_count: a.recipientCount, created_at: a.createdAt,
  });
};

export const getAllAnnouncements = () =>
  all(supabase.from('announcements').select('*').order('created_at', { ascending: false }));

// ── Audit helper ──────────────────────────────────────────────────────────────

const CONTACT_FALLBACK_KEY = 'contact_submissions';

async function getFallbackContacts() {
  const row = await getSetting(CONTACT_FALLBACK_KEY).catch(() => null);
  try {
    const parsed = JSON.parse(row?.value || '[]');
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function saveFallbackContacts(items) {
  await setSetting(CONTACT_FALLBACK_KEY, JSON.stringify(items.slice(0, 500)));
}

export async function insertContactSubmission(c) {
  const row = {
    id: c.id,
    name: c.name,
    last_name: c.lastName,
    phone: c.phone,
    email: c.email,
    message: c.message,
    ip: c.ip || null,
    user_agent: c.userAgent || null,
    created_at: c.createdAt,
    read_at: null,
  };
  try {
    const { error } = await supabase.from('contact_submissions').insert(row);
    if (!error) return;
    if (!/relation .*contact_submissions|could not find the table|schema cache/i.test(error.message || '')) {
      throw new Error(error.message);
    }
  } catch (err) {
    if (!/contact_submissions|schema cache|does not exist/i.test(err?.message || '')) throw err;
  }
  const fallback = await getFallbackContacts();
  fallback.unshift(row);
  await saveFallbackContacts(fallback);
}

export async function getContactSubmissions(limit = 100) {
  let tableRows = [];
  try {
    const { data, error } = await supabase
      .from('contact_submissions')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);
    if (!error) tableRows = data || [];
  } catch {}
  const fallbackRows = await getFallbackContacts();
  const seen = new Set();
  return [...tableRows, ...fallbackRows]
    .filter((row) => {
      if (!row?.id || seen.has(row.id)) return false;
      seen.add(row.id);
      return true;
    })
    .sort((a, b) => String(b.created_at || '').localeCompare(String(a.created_at || '')))
    .slice(0, limit);
}

const CLONE_FILES_BUCKET = 'clone-files';
/** Free-tier safe default (~50MB). Pro can raise in the Supabase dashboard. */
const CLONE_FILES_MAX_BYTES = Math.max(
  1 * 1024 * 1024,
  parseInt(process.env.CLONYFY_STORAGE_MAX_BYTES || String(50 * 1024 * 1024), 10) || (50 * 1024 * 1024),
);
let _cloneBucketReady = false;

async function ensureCloneFilesBucket() {
  if (_cloneBucketReady) return;
  const { error } = await supabase.storage.createBucket(CLONE_FILES_BUCKET, {
    public: false,
    fileSizeLimit: CLONE_FILES_MAX_BYTES,
  });
  if (error && !/already exists|already owned|duplicate|resource already exists/i.test(error.message || '')) {
    throw new Error(error.message);
  }
  const { error: updateErr } = await supabase.storage.updateBucket(CLONE_FILES_BUCKET, {
    public: false,
    fileSizeLimit: CLONE_FILES_MAX_BYTES,
  });
  if (updateErr) console.warn('[clone-files bucket] could not set fileSizeLimit:', updateErr.message);
  _cloneBucketReady = true;
}

export async function uploadCloneFile(path, bytes, contentType = 'application/octet-stream') {
  await ensureCloneFilesBucket();
  const body = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  if (body.length > CLONE_FILES_MAX_BYTES) {
    throw new Error(`The object exceeded the maximum allowed size (${body.length} > ${CLONE_FILES_MAX_BYTES})`);
  }
  const { error } = await supabase.storage
    .from(CLONE_FILES_BUCKET)
    .upload(path, body, { contentType, upsert: true });
  if (error) throw new Error(error.message);
}

export async function downloadCloneFile(path) {
  await ensureCloneFilesBucket();
  const { data, error } = await supabase.storage.from(CLONE_FILES_BUCKET).download(path);
  if (error || !data) return null;
  return Buffer.from(await data.arrayBuffer());
}

export async function createCloneFileSignedUrl(path, expiresIn = 3600) {
  await ensureCloneFilesBucket();
  const { data, error } = await supabase.storage
    .from(CLONE_FILES_BUCKET)
    .createSignedUrl(path, expiresIn);
  if (error || !data?.signedUrl) throw new Error(error?.message || 'Could not create download URL');
  return data.signedUrl;
}

/** True when Storage rejected the object for size (bucket or plan global cap). */
export function isStorageSizeLimitError(err) {
  const msg = String(err?.message || err || '');
  return /maximum allowed size|Payload too large|exceeded the maximum|413/i.test(msg);
}

/**
 * Upload an export ZIP for signed download. Uses a single object when possible;
 * splits into parts under the Storage size cap (common Free-tier ~50MB global)
 * so Export Code still works for larger clones on Vercel.
 */
export async function uploadExportZipForDownload(storagePrefix, zipPath, zipName) {
  await ensureCloneFilesBucket();
  const { readFileSync, openSync, readSync, closeSync, statSync } = await import('fs');
  const size = statSync(zipPath).size;
  const expiresIn = 60 * 60;

  const uploadSingle = async () => {
    const storagePath = `${storagePrefix}/${zipName}`;
    await uploadCloneFile(storagePath, readFileSync(zipPath), 'application/zip');
    const downloadUrl = await createCloneFileSignedUrl(storagePath, expiresIn);
    return { mode: 'single', downloadUrl, zipName, size };
  };

  const uploadParts = async (chunkSize) => {
    const fd = openSync(zipPath, 'r');
    const parts = [];
    try {
      let offset = 0;
      let index = 0;
      while (offset < size) {
        const len = Math.min(chunkSize, size - offset);
        const buf = Buffer.alloc(len);
        const n = readSync(fd, buf, 0, len, offset);
        if (n <= 0) break;
        const partPath = `${storagePrefix}/${zipName}.part${String(index).padStart(4, '0')}`;
        await uploadCloneFile(partPath, n === len ? buf : buf.subarray(0, n), 'application/octet-stream');
        const url = await createCloneFileSignedUrl(partPath, expiresIn);
        parts.push({ url, index, size: n });
        offset += n;
        index++;
      }
    } finally {
      closeSync(fd);
    }
    if (!parts.length) throw new Error('Export ZIP could not be uploaded');
    return { mode: 'parts', parts, zipName, size, partCount: parts.length };
  };

  // Prefer one object when the ZIP is modest; fall back to chunks on size errors.
  if (size <= 40 * 1024 * 1024) {
    try {
      return await uploadSingle();
    } catch (err) {
      if (!isStorageSizeLimitError(err)) throw err;
    }
  }

  let chunkSize = 40 * 1024 * 1024;
  let lastErr = null;
  while (chunkSize >= 1024 * 1024) {
    try {
      return await uploadParts(chunkSize);
    } catch (err) {
      lastErr = err;
      if (!isStorageSizeLimitError(err)) throw err;
      chunkSize = Math.floor(chunkSize / 2);
    }
  }
  throw new Error(
    lastErr?.message
      || 'Export ZIP exceeds your Supabase Storage file size limit. Raise the clone-files bucket limit in Supabase Storage settings, or upgrade your Supabase plan.',
  );
}

function cloneTextKey(path) {
  return `clonefile:${path}`;
}

export async function saveCloneTextFile(path, text) {
  await supabase.from('settings').upsert({ key: cloneTextKey(path), value: String(text ?? '') });
}

export async function getCloneTextFile(path) {
  const { data } = await supabase.from('settings').select('value').eq('key', cloneTextKey(path)).maybeSingle();
  return data?.value ?? null;
}

export async function audit(userId, userName, action, details, ip) {
  try {
    await insertAudit({
      userId: userId || null, userName: userName || null,
      action, details: details || null, ip: ip || null,
      createdAt: new Date().toISOString(),
    });
    // On serverless, the hourly setInterval prune may never fire (each
    // invocation is short-lived). Piggyback an occasional prune here instead
    // of doing it on every insert, so the table still self-bounds.
    if (Math.random() < 0.01) pruneAuditLog().catch(() => {});
  } catch {}
}
