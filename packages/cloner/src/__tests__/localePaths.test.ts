import { describe, expect, it } from 'vitest';
import {
  isLocaleOnlyPath,
  isLocalePrefixedPath,
  isLocaleSegment,
  shouldSkipLocaleVariant,
} from '../localePaths.js';
import { prioritizeSitemapUrls } from '../crawler.js';

describe('locale path detection', () => {
  it('detects locale-only market roots', () => {
    expect(isLocaleOnlyPath('/es-us')).toBe(true);
    expect(isLocaleOnlyPath('/zh-us')).toBe(true);
    expect(isLocaleOnlyPath('/ae')).toBe(true);
    expect(isLocaleOnlyPath('/at')).toBe(true);
    expect(isLocaleOnlyPath('/nl-be')).toBe(true);
    expect(isLocaleOnlyPath('/en-bg')).toBe(true);
    expect(isLocaleOnlyPath('/zh-hans')).toBe(true);
  });

  it('does not treat real content routes as locales', () => {
    expect(isLocaleOnlyPath('/')).toBe(false);
    expect(isLocaleOnlyPath('/payments')).toBe(false);
    expect(isLocaleOnlyPath('/pricing')).toBe(false);
    expect(isLocaleOnlyPath('/customers/cursor')).toBe(false);
    expect(isLocaleOnlyPath('/docs')).toBe(false);
    expect(isLocaleSegment('payments')).toBe(false);
    expect(isLocaleSegment('pricing')).toBe(false);
  });

  it('detects locale-prefixed content paths', () => {
    expect(isLocalePrefixedPath('/es-us/payments')).toBe(true);
    expect(isLocalePrefixedPath('/fr/pricing')).toBe(true);
    expect(isLocalePrefixedPath('/payments')).toBe(false);
  });

  it('skips other-locale variants when cloning the default site', () => {
    const start = 'https://stripe.com/';
    expect(shouldSkipLocaleVariant('https://stripe.com/es-us', start)).toBe(true);
    expect(shouldSkipLocaleVariant('https://stripe.com/ae', start)).toBe(true);
    expect(shouldSkipLocaleVariant('https://stripe.com/fr-be/payments', start)).toBe(true);
    expect(shouldSkipLocaleVariant('https://stripe.com/payments', start)).toBe(false);
    expect(shouldSkipLocaleVariant('https://stripe.com/pricing', start)).toBe(false);
    expect(shouldSkipLocaleVariant('https://stripe.com/', start)).toBe(false);
  });

  it('keeps the start locale tree when cloning a localized entry URL', () => {
    const start = 'https://stripe.com/es-us';
    expect(shouldSkipLocaleVariant('https://stripe.com/es-us', start)).toBe(false);
    expect(shouldSkipLocaleVariant('https://stripe.com/es-us/payments', start)).toBe(false);
    expect(shouldSkipLocaleVariant('https://stripe.com/fr-be', start)).toBe(true);
    expect(shouldSkipLocaleVariant('https://stripe.com/payments', start)).toBe(false);
  });
});

describe('prioritizeSitemapUrls locale filtering', () => {
  it('excludes locale market roots from sitemap seeds for default-language clones', () => {
    const urls = prioritizeSitemapUrls([
      'https://stripe.com/es-us',
      'https://stripe.com/ae',
      'https://stripe.com/zh-us',
      'https://stripe.com/payments',
      'https://stripe.com/pricing',
      'https://stripe.com/',
      'https://stripe.com/legal/privacy',
    ], 'https://stripe.com/', 10);

    expect(urls).toContain('https://stripe.com/');
    expect(urls).toContain('https://stripe.com/payments');
    expect(urls).toContain('https://stripe.com/pricing');
    expect(urls).not.toContain('https://stripe.com/es-us');
    expect(urls).not.toContain('https://stripe.com/ae');
    expect(urls).not.toContain('https://stripe.com/zh-us');
  });
});
