import { rmSync, createWriteStream, existsSync, readFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';
import archiver from 'archiver';
import { validateFigmaScene } from './figmaSceneGraph.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const CLONER_NODE_MODULES = join(__dirname, '..', 'packages', 'cloner', 'node_modules');

const FIGMA_EXPORT_PAGE_SOURCE = () => readFileSync(join(__dirname, 'figma-export-page.js'), 'utf8')
  .replace(/export\s+default\s+async\s+function\s+figmaExportPage/, 'async function figmaExportPage')
  .replace(/export\s+default\s+/, '');

function isServerlessEnv() {
  return process.env.CLONYFY_SERVERLESS === '1'
    || process.env.CLONYFY_SERVERLESS === 'true'
    || !!process.env.AWS_LAMBDA_FUNCTION_NAME
    || !!process.env.LAMBDA_TASK_ROOT
    || process.cwd().startsWith('/var/task');
}

function isConstrainedFigmaEnv() {
  return isServerlessEnv()
    || process.env.CLONYFY_HOSTED === '1'
    || process.env.CLONYFY_HOSTED === 'true'
    || process.env.CLONYFY_LOW_MEMORY === '1'
    || process.env.CLONYFY_LOW_MEMORY === 'true'
    || !!(process.env.RENDER || process.env.RENDER_EXTERNAL_URL);
}

const IS_SERVERLESS = isServerlessEnv();
const IS_CONSTRAINED = isConstrainedFigmaEnv();
const ZIP_CONCURRENCY = 1;
const FIGMA_EXPORT_BASE = 'https://clonyfy-figma.local';
/** Layer/image budget for hosted Free (Shopify-sized pages). */
const FIGMA_MAX_LAYERS = IS_CONSTRAINED ? 1800 : 6000;
const FIGMA_SET_CONTENT_MS = IS_CONSTRAINED ? 30_000 : 45_000;
const FIGMA_IMAGE_WAIT_MS = IS_CONSTRAINED ? 6_000 : 12_000;

let figmaBrowser = null;
let figmaBrowserLaunch = null;

function isBrowserClosedError(err) {
  const msg = String(err?.message || err || '');
  return /has been closed|Target (page|context|browser)|browser has disconnected|Protocol error/i.test(msg);
}

function stripScrollReveal(html) {
  return String(html)
    .replace(/<script[^>]*data-clonyfy-scroll-reveal[^>]*>[\s\S]*?<\/script>/gi, '')
    .replace(/<style[^>]*id="clonyfy-scroll-reveal-style"[^>]*>[\s\S]*?<\/style>/gi, '');
}

async function importClonerPkg(relativePath) {
  const fullPath = join(CLONER_NODE_MODULES, relativePath);
  if (!existsSync(fullPath)) {
    throw new Error(`Missing dependency at ${relativePath}. Run npm install in packages/cloner.`);
  }
  return import(pathToFileURL(fullPath).href);
}

async function loadPlaywright() {
  try {
    return await importClonerPkg('playwright-core/index.mjs');
  } catch {
    return import('playwright-core');
  }
}

async function loadSparticuzChromium() {
  const mod = await importClonerPkg('@sparticuz/chromium/build/esm/index.mjs');
  const chromium = mod.default;
  if (chromium && typeof chromium.setGraphicsMode === 'function') {
    chromium.setGraphicsMode(false);
  }
  return chromium;
}

function shouldUseBundledChromium(playwrightPath) {
  return IS_SERVERLESS || (process.platform === 'linux' && (!playwrightPath || !existsSync(playwrightPath)));
}

function systemBrowserChannel(playwrightPath) {
  if (IS_SERVERLESS || (playwrightPath && existsSync(playwrightPath))) return undefined;
  if (process.platform === 'win32') return 'msedge';
  if (process.platform === 'darwin') return 'chrome';
  return undefined;
}

async function getLaunchOptions(chromiumLauncher) {
  const playwrightPath = IS_SERVERLESS ? '' : chromiumLauncher.executablePath();
  const useBundled = shouldUseBundledChromium(playwrightPath);
  const baseArgs = [
    '--disable-blink-features=AutomationControlled',
    '--no-sandbox',
    '--disable-setuid-sandbox',
    ...(IS_CONSTRAINED ? [
      '--disable-dev-shm-usage',
      '--disable-gpu',
      '--disk-cache-size=0',
      '--media-cache-size=0',
    ] : []),
  ];

  if (useBundled) {
    const sparticuz = await loadSparticuzChromium();
    const executablePath = await sparticuz.executablePath();
    if (!executablePath) {
      throw new Error('Bundled Chromium is unavailable on this server. Try again in a moment.');
    }
    return {
      executablePath,
      args: [...(sparticuz.args || []), ...baseArgs],
      headless: typeof sparticuz.headless === 'boolean' ? sparticuz.headless : true,
    };
  }

  const channel = systemBrowserChannel(playwrightPath);
  if (!channel && (!playwrightPath || !existsSync(playwrightPath))) {
    throw new Error('Chromium is not installed on this server.');
  }

  return {
    executablePath: playwrightPath && existsSync(playwrightPath) ? playwrightPath : undefined,
    channel,
    args: baseArgs,
    headless: true,
  };
}

async function getSharedFigmaBrowser(chromiumLauncher) {
  if (figmaBrowser?.isConnected?.()) return figmaBrowser;
  if (figmaBrowserLaunch) return figmaBrowserLaunch;
  figmaBrowserLaunch = (async () => {
    const launchOptions = await getLaunchOptions(chromiumLauncher);
    const browser = await chromiumLauncher.launch(launchOptions);
    browser.on('disconnected', () => {
      figmaBrowser = null;
      figmaBrowserLaunch = null;
    });
    figmaBrowser = browser;
    return browser;
  })();
  return figmaBrowserLaunch;
}

async function withFigmaBrowser(chromiumLauncher, fn) {
  // One-shot browser on constrained hosts avoids a poisoned shared Chromium after OOM.
  if (IS_CONSTRAINED) {
    const launchOptions = await getLaunchOptions(chromiumLauncher);
    const browser = await chromiumLauncher.launch(launchOptions);
    try {
      return await fn(browser);
    } finally {
      await browser.close().catch(() => {});
    }
  }
  const browser = await getSharedFigmaBrowser(chromiumLauncher);
  return fn(browser);
}

function ensureFigmaExportBase(html) {
  const baseTag = `<base href="${FIGMA_EXPORT_BASE}/">`;
  if (/<base\s/i.test(html)) return html;
  if (/<head[^>]*>/i.test(html)) {
    return html.replace(/<head([^>]*)>/i, `<head$1>${baseTag}`);
  }
  return `<!doctype html><html><head>${baseTag}</head><body>${html}</body></html>`;
}

async function installAssetRoutes(context, readAsset) {
  if (!readAsset) return;
  await context.route(`${FIGMA_EXPORT_BASE}/**`, async (route) => {
    const reqUrl = new URL(route.request().url());
    let relPath = '';
    if (reqUrl.pathname === '/api/asset') {
      relPath = reqUrl.searchParams.get('path') || '';
    } else if (reqUrl.pathname.startsWith('/_assets/')) {
      relPath = `_assets${reqUrl.pathname.slice('/_assets'.length)}`;
    } else {
      return route.continue();
    }
    try {
      relPath = decodeURIComponent(relPath);
      const asset = await readAsset(relPath);
      if (!asset?.body) return route.fulfill({ status: 404, body: 'Not found' });
      return route.fulfill({
        status: 200,
        contentType: asset.contentType || 'application/octet-stream',
        body: asset.body,
      });
    } catch {
      return route.fulfill({ status: 404, body: 'Not found' });
    }
  });
}

async function waitForPageReady(page) {
  await page.evaluate(() => document.fonts?.ready).catch(() => {});
  await page.evaluate(() => {
    try {
      document.querySelectorAll('.clonyfy-reveal').forEach((el) => {
        el.classList.add('clonyfy-in');
        el.style.setProperty('opacity', '1', 'important');
        el.style.setProperty('transform', 'none', 'important');
      });
      document.getElementById('clonyfy-scroll-reveal-style')?.remove();
      document.querySelectorAll('[style*="opacity"]').forEach((el) => {
        if (parseFloat(el.style.opacity || '1') <= 0.05) el.style.setProperty('opacity', '1', 'important');
      });
      document.querySelectorAll('[style*="visibility"]').forEach((el) => {
        if (/hidden/i.test(el.style.visibility || '')) el.style.setProperty('visibility', 'visible', 'important');
      });
      document.documentElement.style.setProperty('opacity', '1', 'important');
      document.documentElement.style.setProperty('visibility', 'visible', 'important');
      if (document.body) {
        document.body.style.setProperty('opacity', '1', 'important');
        document.body.style.setProperty('visibility', 'visible', 'important');
      }
    } catch {}
  }).catch(() => {});
  await page.waitForFunction(() => {
    const imgs = Array.from(document.images);
    return imgs.every((img) => {
      const src = img.getAttribute('src');
      if (!src || src.startsWith('data:')) return true;
      return img.complete && img.naturalWidth > 0;
    });
  }, undefined, { timeout: FIGMA_IMAGE_WAIT_MS }).catch(() => {});
  await page.waitForTimeout(IS_CONSTRAINED ? 250 : 700);
}

/**
 * Scene Graph export — rebuilds the page as native SVG vector layers from
 * computed styles (no screenshots). Playwright is only used to render HTML
 * and run the in-page scene graph walker.
 */
export async function htmlToFigmaSvg(html, {
  viewportWidth = 1440,
  title = 'Clonyfy export',
  readAsset = null,
} = {}) {
  const attempts = IS_CONSTRAINED ? 2 : 1;
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await renderFigmaSvgOnce(html, { viewportWidth, title, readAsset });
    } catch (err) {
      lastErr = err;
      if (attempt + 1 < attempts && isBrowserClosedError(err)) {
        await closeFigmaBrowser();
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

async function injectFigmaExporter(page) {
  await page.addScriptTag({
    content: `${FIGMA_EXPORT_PAGE_SOURCE()}\n;window.__clonyfyFigmaExportPage = figmaExportPage;`,
  });
  const ok = await page.evaluate(() => typeof window.__clonyfyFigmaExportPage === 'function');
  if (!ok) throw new Error('Figma scene graph exporter failed to load');
}

async function renderFigmaExportOnce(html, { viewportWidth, title, readAsset, format = 'svg', route = '/' }) {
  const { chromium } = await loadPlaywright();
  return withFigmaBrowser(chromium, async (browser) => {
    if (!browser.isConnected?.()) {
      throw new Error('Headless browser failed to start. Try again in a moment.');
    }
    const context = await browser.newContext({
      viewport: { width: viewportWidth, height: 900 },
      deviceScaleFactor: 1,
    });
    const page = await context.newPage();
    try {
      await installAssetRoutes(context, readAsset);

      let cleaned = stripScrollReveal(html)
        .replace(/<script[^>]*data-clonyfy-preview-nav[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<script[^>]*data-clonyfy-share-nav[^>]*>[\s\S]*?<\/script>/gi, '');
      if (readAsset) cleaned = ensureFigmaExportBase(cleaned);

      await page.setContent(cleaned, {
        waitUntil: 'domcontentloaded',
        timeout: FIGMA_SET_CONTENT_MS,
      });
      await waitForPageReady(page);
      await injectFigmaExporter(page);

      const result = await page.evaluate(async (opts) => {
        return await window.__clonyfyFigmaExportPage(opts);
      }, {
        viewportWidth,
        maxLayers: FIGMA_MAX_LAYERS,
        maxEmbeddedImageBytes: IS_CONSTRAINED ? 120_000 : 900_000,
        embeddedImageBudget: IS_CONSTRAINED ? 1_600_000 : 8_000_000,
        format,
        name: title,
        route,
      });

      if (format === 'scene') {
        if (!result || typeof result !== 'object' || !Array.isArray(result.nodes)) {
          throw new Error('Figma scene graph export returned empty scene');
        }
        return result;
      }

      let svg = result;
      if (!svg || !String(svg).includes('<svg')) {
        throw new Error('Figma scene graph export returned empty SVG');
      }

      if (title && String(svg).includes('<title>')) {
        svg = String(svg).replace(/<title>[\s\S]*?<\/title>/i, `<title>${String(title).replace(/[<>&]/g, '')}</title>`);
      }

      return String(svg);
    } finally {
      await context.close().catch(() => {});
    }
  });
}

async function renderFigmaSvgOnce(html, { viewportWidth, title, readAsset }) {
  return renderFigmaExportOnce(html, { viewportWidth, title, readAsset, format: 'svg' });
}

/** Step 1/5: current-page scene graph JSON (gradients, strokes, text metrics). */
export async function htmlToFigmaScene(html, {
  viewportWidth = 1440,
  title = 'Clonyfy export',
  route = '/',
  readAsset = null,
} = {}) {
  const attempts = IS_CONSTRAINED ? 2 : 1;
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      const scene = await renderFigmaExportOnce(html, {
        viewportWidth,
        title,
        readAsset,
        format: 'scene',
        route,
      });
      return validateFigmaScene(scene);
    } catch (err) {
      lastErr = err;
      if (attempt + 1 < attempts && isBrowserClosedError(err)) {
        await closeFigmaBrowser();
        continue;
      }
      throw err;
    }
  }
  throw lastErr;
}

export function figmaReadme() {
  return [
    '# Clonyfy → Figma export (Scene Graph)',
    '',
    'Each `.svg` is built from **native vector layers** — no screenshots.',
    '',
    'The exporter walks the rendered DOM and emits:',
    '',
    '- Background fills and CSS linear gradients',
    '- Borders and pseudo-element layers (`::before` / `::after`)',
    '- Images as separate `<image>` layers (inlined when possible)',
    '- Text as editable `<text>` layers positioned with browser Range metrics',
    '',
    '## Import into Figma',
    '',
    '1. Open Figma (desktop or web).',
    '2. Drag the `.svg` onto the canvas, or **File → Import**.',
    '3. Expand section groups in the Layers panel to edit text and images.',
    '',
    '## Notes',
    '',
    '- Matches Preview structurally; complex CSS (blur, 3D, canvas) may differ slightly.',
    '- Icon fonts export as text — install matching fonts in Figma for glyph accuracy.',
    '',
    'Exported by Clonyfy.',
    '',
  ].join('\n');
}

export async function buildFigmaExportZip({ pages, zipPath }) {
  mkdirSync(dirname(zipPath), { recursive: true });
  return new Promise((resolvePromise, reject) => {
    const output = createWriteStream(zipPath);
    const archive = archiver('zip', { zlib: { level: 6 } });
    let settled = false;
    const fail = (err) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    output.on('close', () => {
      if (!settled) {
        settled = true;
        resolvePromise();
      }
    });
    output.on('error', fail);
    archive.on('error', fail);
    archive.pipe(output);
    archive.append(figmaReadme(), { name: 'FIGMA-IMPORT.md' });
    for (const page of pages) {
      archive.append(page.svg, { name: page.filename });
    }
    archive.finalize();
  });
}

export function routeToSvgFilename(route) {
  const part = String(route || '/')
    .replace(/^\/$/, 'home')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .toLowerCase() || 'home';
  return `figma-${part}.svg`;
}

async function mapWithConcurrency(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      results[i] = await fn(items[i], i);
    }
  });
  await Promise.all(workers);
  return results;
}

export async function exportCloneToFigmaZip({
  outDir,
  routes,
  rewriteHtml,
  readHtml,
  readAsset = null,
  viewportWidth = 1440,
  zipPath,
}) {
  const maxRoutes = IS_SERVERLESS ? 12 : 80;
  const routeList = (Array.isArray(routes) ? routes : []).slice(0, maxRoutes);
  if (!routeList.length) throw new Error('No pages to export');

  const pages = [];
  const errors = [];
  await mapWithConcurrency(routeList, ZIP_CONCURRENCY, async (route) => {
    try {
      const raw = await readHtml(outDir, route);
      const html = await rewriteHtml(raw, outDir);
      const svg = await htmlToFigmaSvg(html, { viewportWidth, title: String(route), readAsset });
      pages.push({ route, filename: routeToSvgFilename(route), svg });
    } catch (err) {
      errors.push(`${route}: ${err?.message || err}`);
      await closeFigmaBrowser().catch(() => {});
    }
  });

  if (!pages.length) {
    throw new Error(errors[0] || 'Figma ZIP export failed for all pages');
  }

  try {
    rmSync(zipPath, { force: true });
  } catch {}
  await buildFigmaExportZip({ pages, zipPath });
  if (!existsSync(zipPath)) throw new Error('Figma ZIP was not created');
  return { pageCount: pages.length, zipPath, skipped: errors.length, errors: errors.slice(0, 8) };
}

/** Close pooled browser (optional cleanup on process exit). */
export async function closeFigmaBrowser() {
  if (figmaBrowser?.isConnected?.()) {
    await figmaBrowser.close().catch(() => {});
  }
  figmaBrowser = null;
  figmaBrowserLaunch = null;
}
