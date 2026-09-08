import { describe, it, expect } from 'vitest';
import { safeName } from '../generator.js';

describe('safeName', () => {
  it('maps root route to __root__', () => {
    expect(safeName('/')).toBe('__root__');
  });

  it('converts slashes to double underscores', () => {
    expect(safeName('/about')).toBe('about');
    expect(safeName('/blog/post')).toBe('blog__post');
  });

  it('replaces special characters with underscores', () => {
    expect(safeName('/search?q=test')).toBe('search_q_test');
  });

  it('preserves hyphens', () => {
    expect(safeName('/blog-post')).toBe('blog-post');
  });

  it('decodes percent-encoded characters', () => {
    // Georgian/Cyrillic URLs should decode before sanitizing, not triple-underscore per byte
    const result = safeName('/page/%E1%83%A5%E1%83%90%E1%83%A0%E1%83%97%E1%83%95%E1%83%94%E1%83%9A%E1%83%98');
    expect(result.length).toBeLessThan(80);
    expect(result).not.toMatch(/%/); // no raw percent signs
  });

  it('trims leading/trailing separators', () => {
    const name = safeName('/about/');
    expect(name).not.toMatch(/^[_-]|[_-]$/);
  });

  it('collapses multiple consecutive underscores from slashes', () => {
    const name = safeName('/a//b');
    expect(name).not.toMatch(/___{2,}/);
  });

  it('truncates very long routes and appends a hash', () => {
    const long = '/' + 'a'.repeat(100);
    const name = safeName(long);
    expect(name.length).toBeLessThanOrEqual(82); // 72 + __ + 8 char hash
    expect(name).toMatch(/__[0-9a-f]{8}$/);
  });

  it('different long routes produce different names via hash', () => {
    const a = safeName('/' + 'a'.repeat(100));
    const b = safeName('/' + 'b'.repeat(100));
    expect(a).not.toBe(b);
  });

  it('falls back to __page__ for edge-case empty result', () => {
    // A route that sanitizes to nothing (all special chars)
    // safeName strips leading/trailing separators — if nothing remains, it uses __page__
    const name = safeName('/!@#$%^&*()');
    expect(name).toBe('__page__');
  });
});
