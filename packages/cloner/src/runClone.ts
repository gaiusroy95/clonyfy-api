import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'fs';
import { resolve, join } from 'path';
import { checkRobots } from './robots.js';
import { crawl, isFastCloneProfile, isServerlessRuntime } from './crawler.js';
import { rewriteHtml } from './rewriter.js';
import { analyzeTraffic } from './analyzer.js';
import { generateNextApp, safeName } from './generator.js';
import { initLogger, logger, setLogSink } from './logger.js';
import type { ArtifactWrittenEvent, AssetEntry, ClonerOptions, Manifest } from './types.js';

const IS_SERVERLESS = isServerlessRuntime();
const IS_FAST_CLONE = isFastCloneProfile();
const SKIP_NEXT_GEN = IS_SERVERLESS
  || IS_FAST_CLONE
  || process.env.CLONYFY_SKIP_NEXT === '1'
  || process.env.CLONYFY_SKIP_NEXT === 'true';

export interface CloneRunEvents {
  onLog?: (line: string) => void;
  onArtifactWritten?: (event: ArtifactWrittenEvent) => Promise<void>;
}

export interface CloneRunResult {
  outDir: string;
  pages: number;
  assets: number;
  apiRoutes: number;
  logFile: string;
}

export async function runClone(options: ClonerOptions, events: CloneRunEvents = {}): Promise<CloneRunResult> {
  const opts: ClonerOptions = {
    ...options,
    out: resolve(options.out),
  };

  setLogSink(events.onLog ? (line) => events.onLog?.(line) : null);
  initLogger(opts.out, opts.verbose);

  try {
    logger.info(`\nCLONYFY v0.1`);
    logger.info(`Target      : ${opts.url}`);
    logger.info(`Output      : ${opts.out}`);
    logger.info(`Options     : max-pages=${opts.maxPages} depth=${opts.depth} concurrency=${opts.concurrency} ignore-robots=${opts.ignoreRobots} full-site=${opts.fullSite ? 'yes' : 'no'} verbose=${opts.verbose ?? false}`);
    if (opts.fullSite) {
      logger.info('Full-site mode: crawling all discoverable same-origin pages until the page budget is reached.');
    }
    logger.info(`Log file    : ${join(opts.out, 'cloner.log')}`);
    logger.info(`Tip         : run with --verbose (or DEBUG=1) to see per-asset/rewrite detail on the console`);

    let targetOrigin: string;
    try {
      targetOrigin = new URL(opts.url).origin;
    } catch {
      throw new Error('Invalid URL: ' + opts.url);
    }

    if (!opts.ignoreRobots) {
      logger.info('Checking robots.txt...');
      const { allowed, reason } = await checkRobots(opts.url);
      logger.info(reason);
      if (!allowed) {
        throw new Error(
          'This site’s robots.txt blocks cloning while “Respect robots.txt” is on. Uncheck it and try again (only if you have permission to capture the site).',
        );
      }
    } else {
      logger.info('robots.txt check skipped (--ignore-robots)');
    }

    const assetsDir = join(opts.out, 'public', '_assets');
    mkdirSync(assetsDir, { recursive: true });

    // Write pages incrementally so partial results survive a crash.
    // Must match generator.ts safeName() exactly to avoid orphan files.
    const capturedPagesDir = join(opts.out, 'captured-pages');
    mkdirSync(capturedPagesDir, { recursive: true });
    const routeMap: Record<string, string> = {};
    const pageFilename = (route: string) => `${safeName(route)}.html`;

    async function notifyArtifact(event: ArtifactWrittenEvent) {
      if (!events.onArtifactWritten) return;
      try {
        await events.onArtifactWritten(event);
      } catch (err) {
        const critical = event.kind === 'page' || event.kind === 'route-map' || event.kind === 'manifest';
        logger.warn(`  [OFFLOAD] ${event.relPath}: ${(err as Error).message}`);
        if (critical) throw err;
      }
    }

    logger.info('\nCrawling...');
    let pagesCompleted = 0;
    const rewriteStats: Array<{ url: string; assets: number; network: number }> = [];
    const globalAssets = new Map<string, AssetEntry>();

    const records = await crawl(opts, assetsDir, async (page) => {
      const assetsForRewrite = [
        ...globalAssets.values(),
        ...page.assets,
      ];
      page.html = rewriteHtml({ ...page, assets: assetsForRewrite }, targetOrigin);
      for (const asset of page.assets) {
        globalAssets.set(asset.originalUrl, asset);
        globalAssets.set(asset.originalUrl.split('?')[0].split('#')[0], asset);
      }
      pagesCompleted++;
      rewriteStats.push({ url: page.url, assets: page.assets.length, network: page.network.length });
      logger.info(`  [${pagesCompleted}/${opts.maxPages}] ✓ ${page.url}  (assets: ${page.assets.length}, network: ${page.network.length})`);
      try {
        const filename = pageFilename(page.route);
        const pagePath = join(capturedPagesDir, filename);
        writeFileSync(pagePath, page.html, 'utf8');
        routeMap[page.route] = filename;
        const routeMapPath = join(opts.out, 'route-map.json');
        writeFileSync(routeMapPath, JSON.stringify(routeMap, null, 2), 'utf8');
        await notifyArtifact({ relPath: `captured-pages/${filename}`, absPath: pagePath, kind: 'page' });
        await notifyArtifact({ relPath: 'route-map.json', absPath: routeMapPath, kind: 'route-map' });
      } catch (writeErr) {
        logger.warn(`  [WRITE ERR] ${page.url}: ${(writeErr as Error).message}`);
      }
    }, {
      onArtifactWritten: events.onArtifactWritten,
    });

    logger.info(`\nCaptured ${records.length} page(s).`);
    if (records.length === 0) {
      throw new Error(
        'Clone captured 0 pages. The site timed out, blocked the browser session, or returned no HTML. Try again — for stubborn sites, uncheck “Respect robots.txt” and retry once.',
      );
    }

    logger.info('\n--- Page Summary ---');
    for (const s of rewriteStats) {
      logger.info(`  ${s.url}`);
      logger.info(`    assets=${s.assets}  network_entries=${s.network}`);
    }

    const seenRoutes = new Set<string>();
    const uniqueRecords = records.filter((r) => {
      if (seenRoutes.has(r.route)) {
        logger.debug(`  [DEDUP] Skipping duplicate route ${r.route} from ${r.url}`);
        return false;
      }
      seenRoutes.add(r.route);
      return true;
    });
    if (uniqueRecords.length < records.length) {
      logger.info(`  Deduplicated ${records.length - uniqueRecords.length} duplicate route(s).`);
    }

    const completeAssetMap = new Map<string, AssetEntry>();
    for (const record of uniqueRecords) {
      for (const asset of record.assets) {
        completeAssetMap.set(asset.originalUrl, asset);
        completeAssetMap.set(asset.originalUrl.split('?')[0].split('#')[0], asset);
      }
    }
    const completeAssets = [...completeAssetMap.values()];
    for (const record of uniqueRecords) {
      record.html = rewriteHtml({ ...record, assets: completeAssets }, targetOrigin);
      // Re-write final HTML so serverless offload / persist get the complete asset rewrite.
      try {
        const filename = pageFilename(record.route);
        const pagePath = join(capturedPagesDir, filename);
        writeFileSync(pagePath, record.html, 'utf8');
        routeMap[record.route] = filename;
        await notifyArtifact({ relPath: `captured-pages/${filename}`, absPath: pagePath, kind: 'page' });
      } catch (writeErr) {
        logger.warn(`  [WRITE ERR] final ${record.url}: ${(writeErr as Error).message}`);
      }
    }
    try {
      const routeMapPath = join(opts.out, 'route-map.json');
      writeFileSync(routeMapPath, JSON.stringify(routeMap, null, 2), 'utf8');
      await notifyArtifact({ relPath: 'route-map.json', absPath: routeMapPath, kind: 'route-map' });
    } catch (writeErr) {
      logger.warn(`  [WRITE ERR] route-map.json: ${(writeErr as Error).message}`);
    }

    const allNetwork = uniqueRecords.flatMap((r) => r.network);
    logger.info(`\nTotal network entries across all pages: ${allNetwork.length}`);

    const apiRoutes = analyzeTraffic(allNetwork, targetOrigin);
    logger.info(`Detected ${apiRoutes.length} API route(s).`);

    if (apiRoutes.length > 0) {
      logger.info('\n--- API Routes ---');
      for (const r of apiRoutes) {
        const tag = r.looksLikeForm ? ' [FORM]' : '';
        logger.info(`  ${r.method.padEnd(6)} ${r.path}${tag}`);
        logger.debug(`    fixture=${r.fixtureKey}  fields=${r.inferredFields.join(', ')}`);
        for (const resp of r.responses) {
          logger.debug(`    response: HTTP ${resp.status}`);
        }
      }
    }

    const uniqueAssets = new Set(uniqueRecords.flatMap((r) => r.assets.map((a) => a.localPath)));
    logger.info(`\nTotal unique assets saved: ${uniqueAssets.size}`);

    logger.info('\n--- Captured Routes ---');
    for (const r of uniqueRecords) {
      logger.info(`  ${r.route}`);
    }

    const allConsoleErrors = uniqueRecords.flatMap((r) =>
      r.network.filter((n) => n.method === 'CONSOLE_ERROR').map((n) => ({ url: r.url, body: n.body }))
    );
    if (allConsoleErrors.length > 0) {
      logger.info('\n--- Console Errors ---');
      for (const e of allConsoleErrors) {
        logger.info(`  Page: ${e.url}`);
        logger.info(`  ${e.body}`);
      }
    } else {
      logger.info('\nNo console errors recorded.');
    }

    const manifest: Manifest = {
      targetOrigin,
      capturedAt: new Date().toISOString(),
      pages: uniqueRecords.map((r) => ({
        url: r.url,
        route: r.route,
        html: '',
        // Keep asset map for preview rewrite; drop bulky network logs on hosted/fast
        // so manifest.json stays under Supabase Free storage limits (~50MB).
        assets: r.assets,
        network: (IS_SERVERLESS || IS_FAST_CLONE) ? [] : r.network,
        failedAssets: r.failedAssets,
        failedAssetReasons: r.failedAssetReasons,
      })),
    };
    const manifestPath = join(opts.out, 'manifest.json');
    // Compact JSON on hosted — pretty-print balloons Shopify-sized manifests.
    const manifestJson = (IS_SERVERLESS || IS_FAST_CLONE)
      ? JSON.stringify(manifest)
      : JSON.stringify(manifest, null, 2);
    writeFileSync(manifestPath, manifestJson, 'utf8');
    await notifyArtifact({ relPath: 'manifest.json', absPath: manifestPath, kind: 'manifest' });

    if (!SKIP_NEXT_GEN) {
      logger.info('\nGenerating Next.js app...');
      const fullManifest: Manifest = { ...manifest, pages: uniqueRecords };
      await generateNextApp(opts.out, fullManifest, apiRoutes);
    } else {
      logger.info('\nSkipping Next.js project generation on hosted/fast clone (preview uses captured pages directly).');
    }

    logger.info('\n=== DONE ===');
    logger.info(`Output dir  : ${opts.out}`);
    logger.info(`Pages       : ${uniqueRecords.length}`);
    logger.info(`Assets      : ${uniqueAssets.size}`);
    logger.info(`API routes  : ${apiRoutes.length}`);
    logger.info(`Log file    : ${join(opts.out, 'cloner.log')}`);
    logger.info(`\nNext steps:`);
    logger.info(`  cd "${opts.out}"`);
    logger.info(`  npm install`);
    logger.info(`  npm run dev    # -> http://localhost:3000`);

    return {
      outDir: opts.out,
      pages: uniqueRecords.length,
      assets: uniqueAssets.size,
      apiRoutes: apiRoutes.length,
      logFile: join(opts.out, 'cloner.log'),
    };
  } catch (err) {
    logger.error(err instanceof Error ? err.message : 'Clone failed', err);
    throw err;
  } finally {
    logger.close();
    setLogSink(null);
  }
}

/** Rebuild the Next.js project from persisted manifest + captured HTML (for exports after blob storage). */
export async function regenerateCloneProject(outDir: string): Promise<void> {
  const manifestPath = join(outDir, 'manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error('manifest.json not found — cannot regenerate export project');
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Manifest;
  const routeMapPath = join(outDir, 'route-map.json');
  const routeMap: Record<string, string> = existsSync(routeMapPath)
    ? JSON.parse(readFileSync(routeMapPath, 'utf8'))
    : {};
  const capturedPagesDir = join(outDir, 'captured-pages');
  const readPageHtml = (route: string) => {
    const filename = routeMap[route] || `${safeName(route)}.html`;
    const htmlPath = join(capturedPagesDir, filename);
    return existsSync(htmlPath) ? readFileSync(htmlPath, 'utf8') : '';
  };

  let pages = (manifest.pages || []).map((page) => ({
    ...page,
    html: readPageHtml(page.route),
  }));

  if (!pages.length && Object.keys(routeMap).length) {
    pages = Object.entries(routeMap)
      .filter(([route]) => !route.endsWith('.html'))
      .map(([route, filename]) => {
        const htmlPath = join(capturedPagesDir, filename);
        return {
          url: `${manifest.targetOrigin}${route}`,
          route,
          html: existsSync(htmlPath) ? readFileSync(htmlPath, 'utf8') : '',
          assets: [],
          network: [],
          failedAssets: [],
        };
      });
  }

  const fullManifest: Manifest = { ...manifest, pages };
  const allNetwork = pages.flatMap((p) => p.network || []);
  const apiRoutes = analyzeTraffic(allNetwork, manifest.targetOrigin);
  await generateNextApp(outDir, fullManifest, apiRoutes);
}
