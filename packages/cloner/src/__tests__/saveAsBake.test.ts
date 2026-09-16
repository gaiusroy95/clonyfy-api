import { describe, it, expect } from 'vitest';
import { bakeStaticMediaVisibility } from '../capture.js';

describe('bakeStaticMediaVisibility — Save As level', () => {
  it('strips opacity-0 utility classes and injects visibility bake CSS', () => {
    const html = `<html><head></head><body><h1 class="opacity-0 translate-y-4">Hello</h1><img loading="lazy" src="https://cdn.example.com/a.jpg"></body></html>`;
    const out = bakeStaticMediaVisibility(html);
    expect(out).toContain('clonyfy-static-media-bake');
    expect(out).toContain('loading="eager"');
    expect(out).not.toMatch(/class="[^"]*\bopacity-0\b/);
    expect(out).toContain('Hello');
    expect(out).toMatch(/img,picture,video,source\{opacity:1/);
  });

  it('is idempotent', () => {
    const html = `<html><head></head><body><p class="opacity-0">Text</p></body></html>`;
    const once = bakeStaticMediaVisibility(html);
    const twice = bakeStaticMediaVisibility(once);
    expect(twice).toBe(once);
  });
});
