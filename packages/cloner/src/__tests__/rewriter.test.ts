import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { rewriteHtml } from '../rewriter.js';
import type { PageRecord } from '../types.js';

const ORIGIN = 'https://example.com';

function record(overrides: Partial<PageRecord> = {}): PageRecord {
  return {
    url: `${ORIGIN}/`,
    route: '/',
    html: '<!doctype html><html><head></head><body></body></html>',
    assets: [],
    network: [],
    failedAssets: [],
    ...overrides,
  };
}

describe('rewriteHtml — <base> tag removal', () => {
  it('removes <base> tags entirely', () => {
    const html = `<html><head><base href="https://example.com/"></head><body></body></html>`;
    const out = rewriteHtml(record({ html }), ORIGIN);
    expect(out).not.toContain('<base');
  });

  it('removes <base> with subdirectory href', () => {
    const html = `<html><head><base href="https://example.com/app/"></head><body></body></html>`;
    const out = rewriteHtml(record({ html }), ORIGIN);
    expect(out).not.toContain('<base');
  });

  it('removes self-closing <base />', () => {
    const html = `<html><head><base href="https://example.com/" /></head><body></body></html>`;
    const out = rewriteHtml(record({ html }), ORIGIN);
    expect(out).not.toContain('<base');
  });
});

describe('rewriteHtml — CSP meta tag removal', () => {
  it('removes Content-Security-Policy meta with double-quoted http-equiv', () => {
    const html = `<html><head><meta http-equiv="Content-Security-Policy" content="default-src 'self'"></head><body></body></html>`;
    const out = rewriteHtml(record({ html }), ORIGIN);
    expect(out).not.toMatch(/content-security-policy/i);
  });

  it('removes CSP meta with single-quoted http-equiv', () => {
    const html = `<html><head><meta http-equiv='content-security-policy' content="script-src 'self'"></head><body></body></html>`;
    const out = rewriteHtml(record({ html }), ORIGIN);
    expect(out).not.toMatch(/content-security-policy/i);
  });

  it('does not remove non-CSP meta tags', () => {
    const html = `<html><head><meta charset="UTF-8"><meta name="description" content="test"></head><body></body></html>`;
    const out = rewriteHtml(record({ html }), ORIGIN);
    expect(out).toContain('charset="UTF-8"');
    expect(out).toContain('description');
  });
});

describe('rewriteHtml — asset URL rewriting', () => {
  const prevPrefer = process.env.CLONYFY_PREFER_LIVE_MEDIA;
  beforeEach(() => {
    delete process.env.CLONYFY_PREFER_LIVE_MEDIA;
  });
  afterEach(() => {
    if (prevPrefer === undefined) delete process.env.CLONYFY_PREFER_LIVE_MEDIA;
    else process.env.CLONYFY_PREFER_LIVE_MEDIA = prevPrefer;
  });

  it('rewrites <img src> to /_assets/ path', () => {
    const html = `<html><head></head><body><img src="https://example.com/photo.jpg"></body></html>`;
    const out = rewriteHtml(record({
      html,
      assets: [{ originalUrl: 'https://example.com/photo.jpg', localPath: '/_assets/abc123.jpg' }],
    }), ORIGIN);
    expect(out).toContain('/_assets/abc123.jpg');
    expect(out).not.toContain('https://example.com/photo.jpg');
  });

  it('prefer-live opt-in keeps absolute image URLs', () => {
    process.env.CLONYFY_PREFER_LIVE_MEDIA = '1';
    const html = `<html><head></head><body><img src="https://example.com/photo.jpg"></body></html>`;
    const out = rewriteHtml(record({
      html,
      assets: [{ originalUrl: 'https://example.com/photo.jpg', localPath: '/_assets/abc123.jpg' }],
    }), ORIGIN);
    expect(out).toContain('https://example.com/photo.jpg');
    expect(out).not.toContain('/_assets/abc123.jpg');
  });

  it('rewrites <link href> stylesheet to /_assets/ path', () => {
    const html = `<html><head><link rel="stylesheet" href="https://example.com/styles.css"></head><body></body></html>`;
    const out = rewriteHtml(record({
      html,
      assets: [{ originalUrl: 'https://example.com/styles.css', localPath: '/_assets/def456.css' }],
    }), ORIGIN);
    expect(out).toContain('/_assets/def456.css');
  });

  it('removes SRI integrity attribute when rewriting to local asset', () => {
    const html = `<html><head><link rel="stylesheet" href="https://example.com/styles.css" integrity="sha256-abc123="></head><body></body></html>`;
    const out = rewriteHtml(record({
      html,
      assets: [{ originalUrl: 'https://example.com/styles.css', localPath: '/_assets/def456.css' }],
    }), ORIGIN);
    expect(out).not.toContain('integrity=');
  });

  it('converts same-origin links to root-relative paths', () => {
    const html = `<html><head></head><body><a href="https://example.com/about">About</a></body></html>`;
    const out = rewriteHtml(record({ html }), ORIGIN);
    expect(out).toContain('href="/about"');
    expect(out).not.toContain('https://example.com/about');
  });

  it('leaves external links unchanged', () => {
    const html = `<html><head></head><body><a href="https://other.com/page">External</a></body></html>`;
    const out = rewriteHtml(record({ html }), ORIGIN);
    expect(out).toContain('https://other.com/page');
  });

  it('rewrites srcset attribute correctly', () => {
    const html = `<html><head></head><body><img srcset="https://example.com/img-1x.jpg 1x, https://example.com/img-2x.jpg 2x"></body></html>`;
    const out = rewriteHtml(record({
      html,
      assets: [
        { originalUrl: 'https://example.com/img-1x.jpg', localPath: '/_assets/img1.jpg' },
        { originalUrl: 'https://example.com/img-2x.jpg', localPath: '/_assets/img2.jpg' },
      ],
    }), ORIGIN);
    expect(out).toContain('/_assets/img1.jpg 1x');
    expect(out).toContain('/_assets/img2.jpg 2x');
  });

  it('rewrites imagesrcset preload attributes', () => {
    const html = `<html><head><link rel="preload" as="image" imagesrcset="/_next/image?url=%2Fhero.jpg&amp;w=750&amp;q=75 750w"></head><body></body></html>`;
    const out = rewriteHtml(record({
      html,
      assets: [
        { originalUrl: 'https://example.com/_next/image?url=%2Fhero.jpg&w=750&q=75', localPath: '/_assets/hero.avif' },
      ],
    }), ORIGIN);
    expect(out).toContain('/_assets/hero.avif 750w');
    expect(out).not.toContain('/_next/image');
  });

  it('rewrites captured asset paths inside inline scripts', () => {
    const html = `<html><head><script>self.__next_f.push(["/_next/static/chunks/app.js","\\/_next\\/static\\/chunks\\/lazy.js","\\u002F_next\\u002Fstatic\\u002Fchunks\\u002Fmore.js"])</script></head><body></body></html>`;
    const out = rewriteHtml(record({
      html,
      assets: [
        { originalUrl: 'https://example.com/_next/static/chunks/app.js', localPath: '/_assets/app.js' },
        { originalUrl: 'https://example.com/_next/static/chunks/lazy.js', localPath: '/_assets/lazy.js' },
        { originalUrl: 'https://example.com/_next/static/chunks/more.js', localPath: '/_assets/more.js' },
      ],
    }), ORIGIN);
    expect(out).toContain('/_assets/app.js');
    expect(out).toContain('\\/_assets\\/lazy.js');
    expect(out).toContain('\\u002F_assets\\u002Fmore.js');
    expect(out).not.toContain('/_next/static/chunks');
  });

  it('uses placeholder for known-failed image assets', () => {
    const html = `<html><head></head><body><img src="https://example.com/broken.jpg"></body></html>`;
    const out = rewriteHtml(record({
      html,
      failedAssets: ['https://example.com/broken.jpg'],
    }), ORIGIN);
    expect(out).toContain('/_assets/__placeholder__.svg');
    expect(out).not.toContain('broken.jpg');
  });

  it('rewrites captured CDN images to /_assets (default local clone)', () => {
    const html = `<html><head></head><body><img src="https://cdn.shopify.com/b/shopify-brochure2-assets/abc.png?width=421"></body></html>`;
    const out = rewriteHtml(record({
      html,
      assets: [{
        originalUrl: 'https://cdn.shopify.com/b/shopify-brochure2-assets/abc.png?width=421',
        localPath: '/_assets/shopify-abc.png',
      }],
    }), ORIGIN);
    expect(out).toContain('/_assets/shopify-abc.png');
    expect(out).not.toContain('cdn.shopify.com');
  });

  it('uses placeholder for failed CDN images (no hotlink bypass)', () => {
    const html = `<html><head></head><body><img src="https://cdn.shopify.com/s/files/1/abc/hero.webp?width=1200"></body></html>`;
    const out = rewriteHtml(record({
      html,
      failedAssets: ['https://cdn.shopify.com/s/files/1/abc/hero.webp?width=1200'],
    }), ORIGIN);
    expect(out).toContain('/_assets/__placeholder__.svg');
    expect(out).not.toContain('cdn.shopify.com');
  });

  it('rewrites CDN images when a local asset was captured', () => {
    const html = `<html><head></head><body><img src="https://cdn.shopify.com/b/shopify-brochure2-assets/abc.png?width=421" srcset="https://cdn.shopify.com/b/shopify-brochure2-assets/abc.png?width=842 2x"></body></html>`;
    const out = rewriteHtml(record({
      html,
      assets: [{
        originalUrl: 'https://cdn.shopify.com/b/shopify-brochure2-assets/abc.png?width=842',
        localPath: '/_assets/shopify-abc.png',
      }],
    }), ORIGIN);
    expect(out).toContain('/_assets/shopify-abc.png');
    expect(out).not.toContain('cdn.shopify.com');
  });

  it('rewrites third-party CDN images and fonts to /_assets when captured', () => {
    const html = `<html><head><link rel="stylesheet" href="https://b.examplecdn.com/fonts.css"><style>@font-face{src:url('https://b.examplecdn.com/icon.woff2')}</style></head><body><img src="https://images.examplecdn.com/hero.jpg?w=860"></body></html>`;
    const out = rewriteHtml(record({
      html,
      assets: [
        {
          originalUrl: 'https://images.examplecdn.com/hero.jpg?w=860',
          localPath: '/_assets/hero.jpg',
        },
        {
          originalUrl: 'https://b.examplecdn.com/fonts.css',
          localPath: '/_assets/fonts.css',
        },
        {
          originalUrl: 'https://b.examplecdn.com/icon.woff2',
          localPath: '/_assets/icon.woff2',
        },
      ],
    }), ORIGIN);
    expect(out).toContain('/_assets/hero.jpg');
    expect(out).toContain('/_assets/fonts.css');
    expect(out).toContain('/_assets/icon.woff2');
    expect(out).not.toContain('images.examplecdn.com');
    expect(out).not.toContain('b.examplecdn.com/icon.woff2');
  });

  it('uses captured /_assets even when URL is also in failedAssets', () => {
    const html = `<html><head></head><body><img src="https://cdn.example.com/hero.jpg"></body></html>`;
    const out = rewriteHtml(record({
      html,
      assets: [{ originalUrl: 'https://cdn.example.com/hero.jpg', localPath: '/_assets/hero.jpg' }],
      failedAssets: ['https://cdn.example.com/hero.jpg'],
    }), ORIGIN);
    expect(out).toContain('/_assets/hero.jpg');
    expect(out).not.toContain('__placeholder__');
  });

  it('leaves uncaptured external CDN images absolute (not rewritten to placeholder)', () => {
    const html = `<html><head></head><body><img src="https://cdn.example.com/uncaptured.png"></body></html>`;
    const out = rewriteHtml(record({ html }), ORIGIN);
    expect(out).toContain('cdn.example.com/uncaptured.png');
    expect(out).not.toContain('__placeholder__');
  });

  it('injects fallback font styles', () => {
    const html = `<html><head></head><body><p>Hello</p></body></html>`;
    const out = rewriteHtml(record({ html }), ORIGIN);
    expect(out).toContain('clonyfy-fallback-fonts');
    expect(out).toContain('system-ui');
  });

  it('rewrites inline style url() references', () => {
    const html = `<html><head></head><body><div style="background:url('https://example.com/bg.jpg')"></div></body></html>`;
    const out = rewriteHtml(record({
      html,
      assets: [{ originalUrl: 'https://example.com/bg.jpg', localPath: '/_assets/bg123.jpg' }],
    }), ORIGIN);
    expect(out).toContain('/_assets/bg123.jpg');
  });

  it('rewrites url() references in <style> blocks', () => {
    const html = `<html><head><style>.hero{background:url('https://example.com/hero.jpg')}</style></head><body></body></html>`;
    const out = rewriteHtml(record({
      html,
      assets: [{ originalUrl: 'https://example.com/hero.jpg', localPath: '/_assets/hero.jpg' }],
    }), ORIGIN);
    expect(out).toContain('/_assets/hero.jpg');
  });

  it('blanks out map iframe srcs', () => {
    const html = `<html><head></head><body><iframe src="https://maps.google.com/maps?q=test"></iframe></body></html>`;
    const out = rewriteHtml(record({ html }), ORIGIN);
    expect(out).toContain('about:blank');
    expect(out).not.toContain('maps.google.com');
  });
});
