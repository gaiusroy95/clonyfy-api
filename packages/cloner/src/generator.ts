import { mkdirSync, writeFileSync, rmSync, existsSync, readFileSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import { createHash } from 'crypto';
import Handlebars from 'handlebars';
import type { Manifest, ApiRouteSpec } from './types.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = join(__dirname, '..', 'templates');
const SERVE_PATCHES_PATH = resolve(__dirname, '../../../lib/cloneServePatches.js');

let _servePatches: {
  buildVisibilityPatchHtml: (base?: string, opts?: { includeBase?: boolean }) => string;
  buildScrollAnimationsPatchHtml: () => string;
} | null = null;
async function loadServePatches() {
  if (_servePatches) return _servePatches;
  _servePatches = await import(pathToFileURL(SERVE_PATCHES_PATH).href);
  return _servePatches!;
}

function tpl(name: string, data: Record<string, unknown>): string {
  const src = readFileSync(join(TEMPLATES_DIR, name), 'utf8');
  return Handlebars.compile(src)(data);
}

function write(path: string, content: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, 'utf8');
}

function prismaModelName(path: string): string {
  return path
    .split('/')
    .filter(Boolean)
    .map((s) => s.replace(/[^a-zA-Z]/g, ''))
    .filter(Boolean)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join('') || 'FormSubmission';
}

function toPrismaFields(fields: string[]): string {
  const reserved = new Set(['id', 'createdAt']);
  return fields
    .filter((f) => !reserved.has(f))
    .map((f) => `  ${f.replace(/[^a-zA-Z0-9_]/g, '_')}  String  @default("")`)
    .join('\n');
}

export function safeName(route: string): string {
  if (route === '/') return '__root__';
  // Decode percent-encoded chars first (e.g. Georgian/Cyrillic URLs) to avoid
  // each %XX triplet becoming 3 underscores and blowing past Windows MAX_PATH.
  let decoded = route;
  try { decoded = decodeURIComponent(route); } catch {}
  // Keep hyphens to avoid collision: /blog-post and /blog_post would both become
  // blog_post if hyphens were replaced with underscores.
  const name = decoded
    .replace(/\//g, '__')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .replace(/__+/g, '__')
    .replace(/^[_-]+|[_-]+$/g, '') || '__page__';
  // Keep filenames under 80 chars; append a hash of the original route for uniqueness.
  if (name.length > 80) {
    const hash = createHash('sha1').update(route).digest('hex').slice(0, 8);
    return name.slice(0, 72) + '__' + hash;
  }
  return name;
}

function htmlEsc(value: string): string {
  return value.replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch] ?? ch));
}

function authPageHtml(hostname: string, kind: 'login' | 'register'): string {
  const isRegister = kind === 'register';
  const title = isRegister ? 'Create account' : 'Sign in';
  const subtitle = isRegister ? `Start using ${hostname}` : `Welcome back to ${hostname}`;
  const altHref = isRegister ? '/login' : '/register';
  const altText = isRegister ? 'Already have an account? Sign in' : 'Need an account? Register';
  const fields = isRegister
    ? '<label>Full name<input name="name" autocomplete="name" placeholder="Jane Doe" required></label>'
    : '';
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${htmlEsc(title)} | ${htmlEsc(hostname)}</title>
  <style>
    *{box-sizing:border-box}body{margin:0;min-height:100vh;font-family:Inter,ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif;background:#f5f7fb;color:#111827;display:grid;place-items:center;padding:24px}.auth-shell{width:min(100%,420px);background:#fff;border:1px solid #e5e7eb;border-radius:8px;box-shadow:0 18px 55px rgba(15,23,42,.12);padding:32px}.brand{font-size:13px;font-weight:800;text-transform:uppercase;letter-spacing:.08em;color:#2563eb;margin-bottom:22px}h1{font-size:30px;line-height:1.1;margin:0 0 8px}p{margin:0 0 24px;color:#6b7280;line-height:1.6}form{display:grid;gap:14px}label{display:grid;gap:7px;font-size:13px;font-weight:700;color:#374151}input{height:44px;border:1px solid #d1d5db;border-radius:6px;padding:0 12px;font:inherit;color:#111827;background:#fff}input:focus{outline:3px solid rgba(37,99,235,.16);border-color:#2563eb}button{height:46px;border:0;border-radius:6px;background:#2563eb;color:#fff;font:inherit;font-weight:800;cursor:pointer;margin-top:4px}button:hover{background:#1d4ed8}.alt{display:block;margin-top:18px;color:#2563eb;text-decoration:none;font-size:14px;font-weight:700}.fine{font-size:12px;color:#9ca3af;margin-top:18px;margin-bottom:0}
  </style>
</head>
<body>
  <main class="auth-shell">
    <div class="brand">${htmlEsc(hostname)}</div>
    <h1>${htmlEsc(title)}</h1>
    <p>${htmlEsc(subtitle)}</p>
    <form>
      ${fields}
      <label>Email<input type="email" name="email" autocomplete="email" placeholder="you@example.com" required></label>
      <label>Password<input type="password" name="password" autocomplete="${isRegister ? 'new-password' : 'current-password'}" placeholder="********" required></label>
      <button type="submit">${htmlEsc(title)}</button>
    </form>
    <a class="alt" href="${altHref}">${htmlEsc(altText)}</a>
    <p class="fine">This generated auth page is ready to connect to your real backend.</p>
  </main>
</body>
</html>`;
}

function routeSegments(path: string): string[] {
  return path
    .replace(/^\/+/, '')
    .split('/')
    .filter(Boolean)
    .map((segment) => segment.replace(/:/g, '_'));
}

export async function generateNextApp(outDir: string, manifest: Manifest, apiRoutes: ApiRouteSpec[]) {
  const { pages } = manifest;
  const hostname = new URL(manifest.targetOrigin).hostname;

  // Static assets dir (already populated by capture)
  mkdirSync(join(outDir, 'public', '_assets'), { recursive: true });

  // Write captured HTML files
  const pagesDataDir = join(outDir, 'captured-pages');
  mkdirSync(pagesDataDir, { recursive: true });
  // Preserve existing route-map filenames so regenerate never orphans real HTML
  // (e.g. older clones used __home__.html while safeName('/') is now __root__).
  const existingRouteMap: Record<string, string> = existsSync(join(outDir, 'route-map.json'))
    ? (() => {
        try { return JSON.parse(readFileSync(join(outDir, 'route-map.json'), 'utf8')); }
        catch { return {}; }
      })()
    : {};
  const routeMap: Record<string, string> = { ...existingRouteMap };
  for (const page of pages) {
    const name = safeName(page.route);
    const filename = existingRouteMap[page.route] || `${name}.html`;
    const pageHtmlPath = join(pagesDataDir, filename);
    // Only write when we have real content. Never overwrite a non-empty file
    // with empty HTML (materialized exports keep HTML on disk; manifest omits it).
    if (page.html && page.html.length > 0) {
      writeFileSync(pageHtmlPath, page.html, 'utf8');
    }
    routeMap[page.route] = filename;
    if (page.route !== '/' && page.route.endsWith('.html')) {
      const cleanRoute = page.route.replace(/\.html$/i, '');
      routeMap[cleanRoute] ??= filename;
    } else if (page.route !== '/') {
      routeMap[`${page.route}.html`] ??= filename;
    }
  }

  const authRoutes: Array<{ route: '/login' | '/register'; kind: 'login' | 'register' }> = [
    { route: '/login', kind: 'login' },
    { route: '/register', kind: 'register' },
  ];
  for (const auth of authRoutes) {
    if (routeMap[auth.route]) continue;
    const name = safeName(auth.route);
    writeFileSync(join(pagesDataDir, `${name}.html`), authPageHtml(hostname, auth.kind), 'utf8');
    routeMap[auth.route] = `${name}.html`;
  }
  writeFileSync(join(outDir, 'route-map.json'), JSON.stringify(routeMap, null, 2), 'utf8');

  // API fixtures
  const fixturesDir = join(outDir, 'fixtures');
  mkdirSync(fixturesDir, { recursive: true });
  for (const spec of apiRoutes) {
    for (const resp of spec.responses) {
      const fname = `${spec.fixtureKey}.${spec.method}.${resp.status}.json`;
      try {
        writeFileSync(join(fixturesDir, fname), JSON.stringify({
          status: resp.status,
          contentType: resp.contentType || 'application/json',
          body: resp.body,
        }, null, 2), 'utf8');
      } catch { /* skip unserializable */ }
    }
  }

  // Next.js app files
  write(join(outDir, 'app', 'layout.tsx'), tpl('layout.tsx.hbs', { hostname, targetOrigin: manifest.targetOrigin }));
  // Remove stale page.tsx from prior runs — route.ts takes over the catch-all
  const stalePage = join(outDir, 'app', '[[...slug]]', 'page.tsx');
  if (existsSync(stalePage)) rmSync(stalePage);
  // Route handler serves raw captured HTML (preserves scripts, full <head>, interactivity)
  const servePatches = await loadServePatches();
  write(join(outDir, 'app', '[[...slug]]', 'route.ts'), tpl('page.tsx.hbs', {
    targetOrigin: manifest.targetOrigin,
    targetOriginJson: JSON.stringify(manifest.targetOrigin),
    visibilityPatchJson: JSON.stringify(servePatches.buildVisibilityPatchHtml('/', { includeBase: false })),
    scrollPatchJson: JSON.stringify(servePatches.buildScrollAnimationsPatchHtml()),
  }));

  // API routes — skip CDN/analytics paths that shouldn't be proxied
  const SKIP_API = [/cdn-cgi/, /analytics/, /gtag/, /hotjar/, /mixpanel/, /segment/, /sentry/];
  const filteredRoutes = apiRoutes.filter((r) => !SKIP_API.some((p) => p.test(r.path)));

  for (const spec of filteredRoutes) {
    const segments = routeSegments(spec.path);
    if (segments.length === 0) continue;
    write(join(outDir, 'app', ...segments, 'route.ts'), tpl('route.ts.hbs', {
      method: spec.method,
      path: spec.path,
      fixtureKey: spec.fixtureKey,
      defaultStatus: spec.responses[0]?.status ?? 200,
      looksLikeForm: spec.looksLikeForm,
      modelName: spec.looksLikeForm ? prismaModelName(spec.path) : null,
      sampleRequest: spec.sampleRequest ? JSON.stringify(spec.sampleRequest, null, 2) : null,
    }));
  }

  // Prisma schema — use same filtered set as API routes (skip CDN/analytics)
  const formRoutes = filteredRoutes.filter((r) => r.looksLikeForm && r.inferredFields.length > 0);
  const models = formRoutes.map((r) => ({
    name: prismaModelName(r.path),
    fields: toPrismaFields(r.inferredFields),
  }));
  write(join(outDir, 'prisma', 'schema.prisma'), tpl('schema.prisma.hbs', { models }));

  // lib/replay.ts
  write(join(outDir, 'lib', 'replay.ts'), tpl('replay.ts.hbs', {}));

  // Config files
  write(join(outDir, 'next.config.js'), tpl('next.config.js.hbs', {}));
  write(join(outDir, 'package.json'), tpl('package.json.hbs', {
    siteName: hostname.replace(/\./g, '-'),
    hasPrisma: models.length > 0,
  }));
  write(join(outDir, 'Dockerfile'), tpl('Dockerfile.hbs', {}));
  write(join(outDir, 'docker-compose.yml'), tpl('docker-compose.yml.hbs', {}));
  write(join(outDir, '.env.example'), 'DATABASE_URL="file:./dev.db"\n');
  write(join(outDir, 'tsconfig.json'), tpl('tsconfig.json.hbs', {}));
  write(join(outDir, 'README.md'), tpl('README.md.hbs', {
    targetOrigin: manifest.targetOrigin,
    hostname,
    pagesCount: Object.keys(routeMap).filter((route) => !route.endsWith('.html')).length,
    apiRoutesCount: filteredRoutes.length,
    modelsCount: models.length,
    capturedAt: manifest.capturedAt,
  }));

  console.log(`\nGenerated Next.js app at: ${outDir}`);
  console.log(`  Pages      : ${pages.length}`);
  console.log(`  API routes : ${filteredRoutes.length}`);
  console.log(`  DB models  : ${models.length}`);
  console.log(`\nNext steps:`);
  console.log(`  cd "${outDir}"`);
  console.log(`  npm install`);
  if (models.length > 0) console.log(`  npx prisma db push`);
  console.log(`  npm run build && npm start`);
}
