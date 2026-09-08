#!/usr/bin/env node
/**
 * Week 3 MVP smoke test — preview, save, share APIs against benchmark clones.
 *
 * Usage:
 *   npm start          # in another terminal
 *   npm run smoke:week3
 *
 * Env:
 *   SMOKE_BASE_URL     default http://127.0.0.1:5000
 *   SMOKE_OUT_E1       default output/benchmarks/week2-e1
 *   SMOKE_OUT_L1       default output/benchmarks/week2-l1
 */
import 'dotenv/config';
import { randomUUID } from 'crypto';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { insertClone } from '../db.js';

const BASE = process.env.SMOKE_BASE_URL || 'http://127.0.0.1:5000';
const SITES = [
  { id: 'E1', label: 'echeloninternational.ge', outDir: resolve(process.env.SMOKE_OUT_E1 || 'output/benchmarks/week2-e1'), innerRoute: null },
  { id: 'L1', label: 'limova.ai', outDir: resolve(process.env.SMOKE_OUT_L1 || 'output/benchmarks/week2-l1'), innerRoute: '/offres' },
];

const results = [];

function pass(site, check, detail = '') {
  results.push({ site, check, ok: true, detail });
  console.log(`  ✓ ${check}${detail ? ` — ${detail}` : ''}`);
}

function fail(site, check, detail = '') {
  results.push({ site, check, ok: false, detail });
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
  try { json = text ? JSON.parse(text) : null; } catch { /* html or empty */ }
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
  const email = `smoke-${Date.now()}-${randomUUID().slice(0, 6)}@clonyfy.test`;
  const password = 'SmokeTest1!';
  const { res, json } = await api('/api/auth/register', {
    method: 'POST',
    body: { name: 'Smoke Tester', email, password },
  });
  if (!res.ok || !json?.token) {
    throw new Error(`Register failed: ${json?.error || res.status}`);
  }
  return { token: json.token, user: json.user, email };
}

async function testSite(token, userId, site) {
  console.log(`\n[${site.id}] ${site.label}`);
  if (!existsSync(site.outDir)) {
    fail(site.id, 'clone output exists', site.outDir);
    return;
  }
  pass(site.id, 'clone output exists');

  const cloneId = randomUUID();
  await insertClone({
    id: cloneId,
    userId,
    userName: 'Smoke Tester',
    url: `https://${site.label}`,
    outDir: site.outDir,
    status: 'done',
    pages: null,
    assets: null,
    apiRoutes: null,
    startedAt: new Date().toISOString(),
    completedAt: new Date().toISOString(),
  });

  const outDirEnc = encodeURIComponent(site.outDir);

  const anonPage = await api(`/api/page?outDir=${outDirEnc}&route=/`);
  if (anonPage.res.status === 401) pass(site.id, 'preview requires auth');
  else fail(site.id, 'preview requires auth', `got ${anonPage.res.status}`);

  const pages = await api(`/api/pages?outDir=${outDirEnc}`, { token });
  if (!pages.res.ok || !Array.isArray(pages.json) || pages.json.length === 0) {
    fail(site.id, 'list pages', pages.json?.error || pages.res.status);
    return;
  }
  pass(site.id, 'list pages', `${pages.json.length} route(s)`);

  const home = await api(`/api/page?outDir=${outDirEnc}&route=/`, { token });
  if (!home.res.ok || home.res.headers.get('content-type')?.includes('json')) {
    fail(site.id, 'preview home', `HTTP ${home.res.status}`);
    return;
  }
  pass(site.id, 'preview home', `${home.text.length} bytes HTML`);

  if (home.text.includes('clonyfy-fallback-fonts')) pass(site.id, 'fallback fonts injected');
  else fail(site.id, 'fallback fonts injected');

  if (home.text.includes('/_assets/') || home.text.includes('/api/asset?')) pass(site.id, 'assets referenced in preview');
  else fail(site.id, 'assets referenced in preview');

  if (site.innerRoute) {
    const inner = await api(`/api/page?outDir=${outDirEnc}&route=${encodeURIComponent(site.innerRoute)}`, { token });
    if (inner.res.ok && inner.text.length > 500) pass(site.id, 'preview inner page', site.innerRoute);
    else fail(site.id, 'preview inner page', site.innerRoute);
  }

  const marker = `<!-- smoke-${site.id}-${Date.now()} -->`;
  const saveBody = home.text.includes('<body')
    ? home.text.replace(/<body([^>]*)>/i, `<body$1>${marker}`)
    : marker + home.text;
  const save = await api('/api/save-page', {
    method: 'POST',
    token,
    body: { outDir: site.outDir, route: '/', html: saveBody },
  });
  if (!save.res.ok || !save.json?.ok) {
    fail(site.id, 'save page', save.json?.error || save.res.status);
  } else {
    pass(site.id, 'save page');
    const verify = await api(`/api/page?outDir=${outDirEnc}&route=/`, { token });
    if (verify.text.includes(marker)) pass(site.id, 'save persisted');
    else fail(site.id, 'save persisted');
  }

  const share = await api('/api/share/create', {
    method: 'POST',
    token,
    body: { outDir: site.outDir, route: '/' },
  });
  if (!share.res.ok || !share.json?.shareId) {
    fail(site.id, 'create share link', share.json?.error || share.res.status);
    return;
  }
  pass(site.id, 'create share link', share.json.url);

  const sharePage = await fetch(`${BASE}/share/${share.json.shareId}`);
  const shareHtml = await sharePage.text();
  if (sharePage.ok && shareHtml.length > 500) pass(site.id, 'share page loads', `${shareHtml.length} bytes`);
  else fail(site.id, 'share page loads', `HTTP ${sharePage.status}`);

  if (shareHtml.includes('clonyfy-fallback-fonts') || shareHtml.includes('/_assets/')) {
    pass(site.id, 'share page has styled content');
  } else {
    fail(site.id, 'share page has styled content');
  }
}

async function main() {
  console.log(`Week 3 smoke test → ${BASE}`);
  await ensureServer();

  console.log('\n[AUTH] Registering test user…');
  const { token, user, email } = await registerUser();
  pass('AUTH', 'register + session', email);

  const anonClone = await api('/api/clone', { method: 'POST', body: { url: 'https://example.com' } });
  if (anonClone.res.status === 401) pass('AUTH', 'anonymous clone blocked');
  else fail('AUTH', 'anonymous clone blocked', `got ${anonClone.res.status}`);

  for (const site of SITES) {
    await testSite(token, user.id, site);
  }

  const failed = results.filter((r) => !r.ok);
  console.log(`\n${'─'.repeat(48)}`);
  console.log(`Results: ${results.length - failed.length}/${results.length} passed`);
  if (failed.length) {
    console.error('\nFailed checks:');
    for (const f of failed) console.error(`  [${f.site}] ${f.check}: ${f.detail}`);
    process.exit(1);
  }
  console.log('All smoke checks passed.');
}

main().catch((err) => {
  console.error('\nSmoke test aborted:', err.message);
  process.exit(1);
});
