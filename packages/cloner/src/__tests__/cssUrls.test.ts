import { describe, it, expect } from 'vitest';
import { extractCssUrls, rewriteCssUrls } from '../capture.js';

describe('extractCssUrls', () => {
  it('extracts plain url() references', () => {
    expect(extractCssUrls(`.a{background:url('/img/a.png')}`)).toContain('/img/a.png');
  });

  it('extracts @import targets', () => {
    expect(extractCssUrls(`@import "/css/base.css";`)).toContain('/css/base.css');
  });

  it('extracts bare-string image-set() URLs (regression)', () => {
    const css = `.b{background-image:image-set('/img/b.webp' 1x, '/img/b@2x.webp' 2x)}`;
    const urls = extractCssUrls(css);
    expect(urls).toContain('/img/b.webp');
    expect(urls).toContain('/img/b@2x.webp');
  });

  it('extracts -webkit-image-set() bare strings', () => {
    expect(extractCssUrls(`.d{background:-webkit-image-set('/img/d.png' 1x)}`)).toContain('/img/d.png');
  });

  it('extracts url() forms inside image-set()', () => {
    const css = `.c{background:image-set(url('/img/c.avif') type('image/avif'),url('/img/c.png'))}`;
    const urls = extractCssUrls(css);
    expect(urls).toContain('/img/c.avif');
    expect(urls).toContain('/img/c.png');
  });

  it('does not treat type() MIME hints as URLs', () => {
    const css = `.c{background:image-set(url('/img/c.avif') type('image/avif'))}`;
    expect(extractCssUrls(css)).not.toContain('image/avif');
  });

  it('de-duplicates results', () => {
    const css = `.a{background:url('/img/a.png')}.b{background:url('/img/a.png')}`;
    expect(extractCssUrls(css).filter((u) => u === '/img/a.png')).toHaveLength(1);
  });
});

describe('rewriteCssUrls', () => {
  const map = new Map<string, string>([
    ['/img/a.png', '/_assets/aa.png'],
    ['/img/b.webp', '/_assets/bb.webp'],
    ['/img/b@2x.webp', '/_assets/b2.webp'],
    ['/img/d.png', '/_assets/dd.png'],
  ]);

  it('rewrites plain url()', () => {
    expect(rewriteCssUrls(`.a{background:url('/img/a.png')}`, map)).toContain('/_assets/aa.png');
  });

  it('rewrites bare-string image-set() URLs (regression)', () => {
    const out = rewriteCssUrls(`.b{background-image:image-set('/img/b.webp' 1x, '/img/b@2x.webp' 2x)}`, map);
    expect(out).toContain('/_assets/bb.webp');
    expect(out).toContain('/_assets/b2.webp');
    expect(out).not.toContain('/img/b.webp');
  });

  it('rewrites -webkit-image-set() and preserves the prefix', () => {
    const out = rewriteCssUrls(`.d{background:-webkit-image-set('/img/d.png' 1x)}`, map);
    expect(out).toContain('-webkit-image-set(');
    expect(out).toContain('/_assets/dd.png');
  });

  it('leaves unmapped URLs untouched', () => {
    const css = `.x{background:image-set('/img/unknown.webp' 1x)}`;
    expect(rewriteCssUrls(css, map)).toContain('/img/unknown.webp');
  });
});
