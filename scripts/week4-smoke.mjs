#!/usr/bin/env node
/**
 * Week 4 ship smoke test — extends Week 3 with edit quota, export gate, share URL host.
 *
 * Usage:
 *   npm start
 *   npm run smoke:week4
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { resolve } from 'path';
import { existsSync, readFileSync } from 'fs';
import { insertClone, updateUser } from '../db.js';

const BASE = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:5000';
const OUT_E1 = resolve(process.env.SMOKE_OUT_E1 || 'output/benchmarks/week2-e1');

const results = [];

function pass(check, detail = '') {
  results.push({ check, ok: true, detail });
  console.log(`  ✓ ${check}${detail ? ` — ${detail}` : ''}`);
}

function fail(check, detail = '') {
  results.push({ check, ok: false, detail });
  console.error(`  ✗ ${check}${detail ? ` — ${detail}` : ''}`);
}

async function api(path, { method = 'GET', token, body } = {}) {
  const headers = { Accept: 'application/json' };
  if (token) headers['x-auth-token'] = token;
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* html */ }
  return { res, text, json };
}

async function ensureServer() {
  try {
    const res = await fetch(BASE, { method: 'HEAD', signal: AbortSignal.timeout(5_000) });
    if (!res.ok && res.status !== 405) throw new Error(`HTTP ${res.status}`);
  } catch (err) {
    throw new Error(`Server not reachable at ${BASE} — run "npm start" first (${err.message})`);
  }
}

async function registerUser() {
  const email = `week4-${Date.now()}-${randomUUID().slice(0, 6)}@clonyfy.test`;
  const password = 'Week4Test1!';
  const { res, json } = await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Week 4 Tester', email, password },
  });
  if (!res.ok || !json?.token) throw new Error(`Register failed: ${json?.error || res.status}`);
  return { token: json.token, user: json.user, email };
}

async function main() {
  console.log(`Week 4 ship smoke test → ${BASE}`);
  await ensureServer();

  if (!existsSync(OUT_E1)) throw new Error(`Missing benchmark clone: ${OUT_E1}`);

  console.log('\n[SETUP] User + clone');
  const { token, user, email } = await registerUser();
  pass('register test user', user.email);

  const cloneId = randomUUID();
  await insertClone({
    id: cloneId,
    userId: user.id,
    userName: user.name,
    url: 'https://www.echeloninternational.ge',
    outDir: OUT_E1,
    status: 'done',
    pages: 1,
    assets: 337,
    apiRoutes: 0,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  });
  pass('seed E1 clone record');

  const outDirEnc = encodeURIComponent(OUT_E1);

  console.log('\n[EDIT] Quota + save round-trip');
  const editQuota = await api('/api/usage/consume', {
    method: 'POST',
    token,
    body: { kind: 'edit', outDir: OUT_E1 },
  });
  if (editQuota.res.ok && editQuota.json?.ok) pass('edit quota consume');
  else fail('edit quota consume', editQuota.json?.error || editQuota.res.status);

  const home = await api(`/api/page?outDir=${outDirEnc}&route=/`, { token });
  if (!home.res.ok) throw new Error('Could not load home for edit test');
  const marker = `<!-- week4-edit-${Date.now()} -->`;
  const edited = home.text.replace(/<body([^>]*)>/i, `<body$1>${marker}`);
  const save = await api('/api/save-page', {
    method: 'POST',
    token,
    body: { outDir: OUT_E1, route: '/', html: edited },
  });
  if (save.res.ok && save.json?.ok) pass('editor save round-trip');
  else fail('editor save round-trip', save.json?.error || save.res.status);

  const verify = await api(`/api/page?outDir=${outDirEnc}&route=/`, { token });
  if (verify.text.includes(marker)) pass('edited marker persisted');
  else fail('edited marker persisted');

  console.log('\n[SHARE] Local host URL');
  const share = await api('/api/share/create', {
    method: 'POST',
    token,
    body: { outDir: OUT_E1, route: '/' },
  });
  if (!share.res.ok || !share.json?.url) {
    fail('create share link', share.json?.error || share.res.status);
  } else {
    const shareUrl = new URL(share.json.url);
    const baseHost = new URL(BASE).host;
    if (shareUrl.host === baseHost) pass('share URL uses local host', share.json.url);
    else fail('share URL uses local host', `got ${shareUrl.host}, expected ${baseHost}`);

    const sharePage = await fetch(share.json.url);
    if (sharePage.ok) pass('share page loads', `${sharePage.status}`);
    else fail('share page loads', `HTTP ${sharePage.status}`);
  }

  console.log('\n[EXPORT] Paid gate + ZIP');
  const freeExport = await api('/api/export-zip', {
    method: 'POST',
    token,
    body: { outDir: OUT_E1 },
  });
  if (freeExport.res.status === 403) pass('free user blocked from ZIP export');
  else fail('free user blocked from ZIP export', `got ${freeExport.res.status}`);

  await updateUser(user.id, { plan: 'starter' });
  pass('upgrade test user to starter');

  const relogin = await api('/api/auth/login', {
    method: 'POST',
    body: { email, password: 'Week4Test1!' },
  });
  if (!relogin.res.ok || !relogin.json?.token) fail('refresh session after upgrade', relogin.json?.error || relogin.res.status);
  else pass('refresh session after upgrade');
  const paidToken = relogin.json?.token || token;

  const paidExport = await api('/api/export-zip', {
    method: 'POST',
    token: paidToken,
    body: { outDir: OUT_E1 },
  });
  if (paidExport.res.ok && paidExport.json?.ok) pass('paid user can build ZIP');
  else fail('paid user can build ZIP', paidExport.json?.error || paidExport.res.status);

  const dl = await fetch(`${BASE}/api/download-zip?outDir=${outDirEnc}`, {
    headers: { 'x-auth-token': paidToken },
  });
  if (dl.ok) {
    const buf = Buffer.from(await dl.arrayBuffer());
    const isZip = buf.length > 4 && buf[0] === 0x50 && buf[1] === 0x4b;
    if (isZip) pass('ZIP download is valid PKZIP', `${Math.round(buf.length / 1024)} KB`);
    else fail('ZIP download is valid PKZIP', 'missing PK header');
  } else {
    fail('ZIP download', `HTTP ${dl.status}`);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'─'.repeat(48)}`);
  console.log(`Results: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    for (const f of failed) console.error(`  ✗ ${f.check}: ${f.detail}`);
    process.exit(1);
  }
  console.log('Week 4 ship smoke checks passed.');
}

main().catch((err) => {
  console.error('\nWeek 4 smoke aborted:', err.message);
  process.exit(1);
});
