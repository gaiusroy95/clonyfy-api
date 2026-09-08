import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  FIGMA_SCENE_KIND,
  FIGMA_SCENE_VERSION,
  svgToFigmaScene,
  validateFigmaScene,
  countSceneNodes,
  parseCssLinearGradient,
} from '../figmaSceneGraph.js';

const SAMPLE_SVG = `<?xml version="1.0" encoding="UTF-8"?>
<svg xmlns="http://www.w3.org/2000/svg" width="1440" height="900" viewBox="0 0 1440 900">
<title>Home</title>
<defs>
<linearGradient id="g1" x1="0%" y1="0%" x2="0%" y2="100%"><stop offset="0%" stop-color="#ff0000"/><stop offset="100%" stop-color="#0000ff"/></linearGradient>
</defs>
<rect id="page-background" x="0" y="0" width="1440" height="900" fill="#ffffff"/>
<g id="header" data-clonyfy-section="true">
<rect id="header-fill" x="0" y="0" width="1440" height="80" fill="#111111" rx="0"/>
<text id="text-1" x="24" y="50" fill="#ffffff" font-family="Inter" font-size="20" font-weight="700" font-style="normal" letter-spacing="normal">Shopify</text>
<image id="logo" x="1200" y="16" width="48" height="48" href="https://cdn.example.com/logo.png" preserveAspectRatio="xMidYMid meet"/>
</g>
<g id="main" data-clonyfy-section="true">
<rect id="hero-fill" x="40" y="120" width="800" height="400" fill="#f5f5f5" rx="12"/>
<rect id="hero-grad" x="40" y="120" width="800" height="400" fill="url(#g1)" rx="12"/>
<rect id="hero-border" x="40" y="120" width="800" height="400" rx="12" fill="none" stroke="#333333" stroke-width="2"/>
<text id="text-2" x="64" y="180" fill="#111111" font-family="Inter" font-size="48" font-weight="700" font-style="normal">Sell online</text>
</g>
</svg>`;

describe('svgToFigmaScene', () => {
  it('builds a valid v1 scene with FRAME, RECT, TEXT, and IMAGE', () => {
    const scene = svgToFigmaScene(SAMPLE_SVG, { name: 'Shopify /', route: '/' });
    validateFigmaScene(scene);

    assert.equal(scene.kind, FIGMA_SCENE_KIND);
    assert.equal(scene.version, FIGMA_SCENE_VERSION);
    assert.deepEqual(scene.page, { width: 1440, height: 900, fill: '#ffffff' });
    assert.equal(scene.route, '/');
    assert.deepEqual(scene.nodes.map((n) => n.type), ['FRAME', 'FRAME']);
    assert.deepEqual(scene.nodes.map((n) => n.name), ['header', 'main']);

    const headerKids = scene.nodes[0].children;
    assert.deepEqual(headerKids.map((n) => n.type), ['RECT', 'IMAGE', 'TEXT']);
    assert.equal(headerKids.find((n) => n.type === 'TEXT').characters, 'Shopify');
    assert.ok(headerKids.find((n) => n.type === 'IMAGE').src.includes('logo.png'));
    assert.equal(headerKids.find((n) => n.type === 'IMAGE').objectFit, 'contain');

    const mainKids = scene.nodes[1].children;
    assert.equal(mainKids.find((n) => n.name === 'hero-fill').cornerRadius, 12);
    assert.equal(mainKids.find((n) => n.type === 'TEXT').characters, 'Sell online');
    assert.ok(countSceneNodes(scene) >= 6);
  });

  it('maps SVG linear gradients and strokes (Step 5)', () => {
    const scene = svgToFigmaScene(SAMPLE_SVG);
    const mainKids = scene.nodes[1].children;
    const grad = mainKids.find((n) => n.name === 'hero-grad');
    assert.equal(grad.fill.type, 'GRADIENT_LINEAR');
    assert.equal(grad.fill.stops.length, 2);
    assert.equal(grad.fill.stops[0].color, '#ff0000');

    const border = mainKids.find((n) => n.name === 'hero-border');
    assert.equal(border.fill, undefined);
    assert.deepEqual(border.stroke, { color: '#333333', weight: 2 });
  });

  it('skips unknown url(#...) fills without a matching def', () => {
    const svg = `<svg width="100" height="100"><g id="Page" data-clonyfy-section="true">
      <rect id="g" x="0" y="0" width="100" height="100" fill="url(#missing)"/>
      <text id="t" x="8" y="24" fill="#000" font-size="16">Hi</text>
    </g></svg>`;
    const scene = svgToFigmaScene(svg);
    const kids = scene.nodes[0].children;
    assert.equal(kids.some((n) => n.type === 'RECT'), false);
    assert.equal(kids.some((n) => n.type === 'TEXT'), true);
  });

  it('rejects invalid scenes', () => {
    assert.throws(() => validateFigmaScene({}), /kind/);
  });
});

describe('parseCssLinearGradient', () => {
  it('parses angle and stops', () => {
    const g = parseCssLinearGradient('linear-gradient(135deg, #111 0%, #eee 100%)');
    assert.equal(g.type, 'GRADIENT_LINEAR');
    assert.equal(g.angle, 135);
    assert.equal(g.stops[0].color, '#111');
    assert.equal(g.stops[0].position, 0);
    assert.equal(g.stops[1].position, 1);
  });

  it('parses to-right keyword', () => {
    const g = parseCssLinearGradient('linear-gradient(to right, red, blue)');
    assert.equal(g.angle, 90);
    assert.equal(g.stops.length, 2);
  });
});
