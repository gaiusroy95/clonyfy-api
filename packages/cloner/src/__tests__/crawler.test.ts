import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { isServerlessRuntime, isProbablyHtmlDocument, prioritizeSitemapUrls, shouldUseBundledChromium, shouldUseStaticFirstServerless, systemBrowserChannel, isFastCloneProfile } from '../crawler.js';

let tempDir = '';

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true });
  tempDir = '';
});

function tempFile() {
  tempDir = mkdtempSync(join(tmpdir(), 'clonyfy-browser-'));
  const file = join(tempDir, 'chromium');
  writeFileSync(file, '');
  return file;
}

describe('shouldUseBundledChromium', () => {
  it('uses bundled Chromium in serverless environments', () => {
    expect(shouldUseBundledChromium('/missing/chromium', 'linux', true)).toBe(true);
  });

  it('uses bundled Chromium on Linux when the Playwright browser is missing', () => {
    expect(shouldUseBundledChromium('/missing/chromium', 'linux', false)).toBe(true);
  });

  it('uses Playwright Chromium on Linux when the executable exists', () => {
    expect(shouldUseBundledChromium(tempFile(), 'linux', false)).toBe(false);
  });

  it('does not use the Linux bundled Chromium on Windows development machines', () => {
    expect(shouldUseBundledChromium('/missing/chromium.exe', 'win32', false)).toBe(false);
  });
});

describe('isServerlessRuntime', () => {
  it('detects Vercel runtime markers', () => {
    expect(isServerlessRuntime({ VERCEL: '1' }, '/repo')).toBe(true);
    expect(isServerlessRuntime({ VERCEL_ENV: 'production' }, '/repo')).toBe(true);
    expect(isServerlessRuntime({ CLONYFY_SERVERLESS: '1' }, '/repo')).toBe(true);
  });

  it('detects Lambda runtime markers', () => {
    expect(isServerlessRuntime({ AWS_LAMBDA_FUNCTION_NAME: 'api' }, '/repo')).toBe(true);
    expect(isServerlessRuntime({ LAMBDA_TASK_ROOT: '/var/task' }, '/repo')).toBe(true);
  });

  it('detects bundled serverless task paths', () => {
    expect(isServerlessRuntime({}, '/var/task')).toBe(true);
    expect(isServerlessRuntime({}, '/var/task/packages/cloner')).toBe(true);
  });
});

describe('isFastCloneProfile', () => {
  it('quality mode (default) disables auto-fast on hosted markers', () => {
    expect(isFastCloneProfile({ RENDER: 'true' }, '/repo')).toBe(false);
    expect(isFastCloneProfile({ RENDER_EXTERNAL_URL: 'https://x.onrender.com' }, '/repo')).toBe(false);
    expect(isFastCloneProfile({ CLONYFY_HOSTED: '1' }, '/repo')).toBe(false);
  });

  it('allows explicit fast mode and quality-off hosted fast', () => {
    expect(isFastCloneProfile({ CLONYFY_FAST_CLONE: '1' }, '/repo')).toBe(true);
    expect(isFastCloneProfile({ RENDER: 'true', CLONYFY_QUALITY: '0' }, '/repo')).toBe(true);
    expect(isFastCloneProfile({ CLONYFY_HOSTED: '1', CLONYFY_QUALITY: '0' }, '/repo')).toBe(true);
  });

  it('allows opting out of fast mode', () => {
    expect(isFastCloneProfile({ RENDER: 'true', CLONYFY_FAST_CLONE: '0' }, '/repo')).toBe(false);
  });

  it('does not force fast mode on plain local env', () => {
    expect(isFastCloneProfile({}, '/repo')).toBe(false);
  });
});

describe('shouldUseStaticFirstServerless', () => {
  it('uses browser-first capture by default in serverless environments', () => {
    expect(shouldUseStaticFirstServerless({}, true)).toBe(false);
  });

  it('allows static-first mode through an explicit environment flag', () => {
    expect(shouldUseStaticFirstServerless({ CLONYFY_STATIC_FIRST: '1' }, true)).toBe(true);
  });

  it('lets browser-first override static-first when both flags are present', () => {
    expect(shouldUseStaticFirstServerless({ CLONYFY_STATIC_FIRST: '1', CLONYFY_BROWSER_FIRST: '1' }, true)).toBe(false);
  });
});

describe('systemBrowserChannel', () => {
  it('uses Edge on Windows when Playwright Chromium is missing', () => {
    expect(systemBrowserChannel('/missing/chromium.exe', 'win32', false)).toBe('msedge');
  });

  it('does not use a system browser in serverless environments', () => {
    expect(systemBrowserChannel('/missing/chromium', 'linux', true)).toBeUndefined();
  });

  it('does not use a system browser when Playwright Chromium exists', () => {
    expect(systemBrowserChannel(tempFile(), 'win32', false)).toBeUndefined();
  });
});

describe('isProbablyHtmlDocument', () => {
  it('detects HTML documents by content type and markup', () => {
    expect(isProbablyHtmlDocument('<!DOCTYPE html><html><head></head><body></body></html>', 'text/html')).toBe(true);
    expect(isProbablyHtmlDocument('<html><body>Hi</body></html>')).toBe(true);
    expect(isProbablyHtmlDocument('<?xml version="1.0"?><urlset></urlset>', 'application/xml')).toBe(false);
  });
});

describe('prioritizeSitemapUrls', () => {
  it('prioritizes the start URL and shallow marketing paths over legal pages', () => {
    const urls = prioritizeSitemapUrls([
      'https://stripe.com/legal/privacy',
      'https://stripe.com/pricing',
      'https://stripe.com/',
      'https://stripe.com/legal/terms',
      'https://stripe.com/products/payments',
    ], 'https://stripe.com/', 3);

    expect(urls).toHaveLength(3);
    expect(urls[0]).toBe('https://stripe.com/');
    expect(urls).toContain('https://stripe.com/pricing');
    expect(urls).not.toContain('https://stripe.com/legal/privacy');
  });
});
