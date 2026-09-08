import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseCssColor,
  figmaFontStyle,
  relativeBox,
  imageScaleMode,
  cssAngleToGradientTransform,
} from '../helpers.mjs';

describe('figma plugin helpers', () => {
  it('parses hex and rgb colors', () => {
    assert.deepEqual(parseCssColor('#fff'), { r: 1, g: 1, b: 1, a: 1 });
    assert.deepEqual(parseCssColor('#111111'), {
      r: 17 / 255,
      g: 17 / 255,
      b: 17 / 255,
      a: 1,
    });
    assert.deepEqual(parseCssColor('rgb(255, 0, 0)'), { r: 1, g: 0, b: 0, a: 1 });
    assert.deepEqual(parseCssColor('rgba(255, 0, 0, 0.5)'), { r: 1, g: 0, b: 0, a: 0.5 });
    assert.equal(parseCssColor('transparent'), null);
    assert.equal(parseCssColor('url(#g1)'), null);
  });

  it('maps CSS weight to a Figma font style', () => {
    assert.equal(figmaFontStyle('400', 'normal'), 'Regular');
    assert.equal(figmaFontStyle('700', 'normal'), 'Bold');
    assert.equal(figmaFontStyle('400', 'italic'), 'Italic');
    assert.equal(figmaFontStyle('700', 'italic'), 'Bold Italic');
  });

  it('converts absolute boxes to parent-relative', () => {
    assert.deepEqual(
      relativeBox({ x: 40, y: 120, w: 800, h: 400 }, { x: 0, y: 0 }),
      { x: 40, y: 120, w: 800, h: 400 },
    );
    assert.deepEqual(
      relativeBox({ x: 80, y: 160, w: 10, h: 10 }, { x: 40, y: 120 }),
      { x: 40, y: 40, w: 10, h: 10 },
    );
  });

  it('maps object-fit to Figma image scale modes', () => {
    assert.equal(imageScaleMode('contain'), 'FIT');
    assert.equal(imageScaleMode('cover'), 'FILL');
    assert.equal(imageScaleMode('fill'), 'FILL');
  });

  it('builds a gradient transform for CSS angles', () => {
    const t90 = cssAngleToGradientTransform(90);
    assert.equal(t90.length, 2);
    assert.equal(t90[0].length, 3);
    // 90deg (to right) ≈ identity-ish along +x
    assert.ok(Math.abs(t90[0][0] - 1) < 1e-9);
    assert.ok(Math.abs(t90[1][1] - 1) < 1e-9);
  });
});
