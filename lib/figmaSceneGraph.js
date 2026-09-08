/**
 * Clonyfy Figma Scene Graph v1 (Steps 1 + 5).
 *
 * Stable JSON the Figma plugin consumes. Built from the DOM exporter
 * (format: "scene") or from scene-graph SVG.
 *
 * Node types: FRAME, RECT, TEXT, IMAGE.
 *
 * Step 5 (additive, still version 1):
 * - RECT.fill may be a CSS color string or { type: 'GRADIENT_LINEAR', angle, stops }
 * - RECT.stroke: { color, weight }
 * - RECT.cornerRadii: { tl, tr, br, bl } when corners differ
 * - TEXT.lineHeight, textAlign, textDecoration
 */

export const FIGMA_SCENE_KIND = 'clonyfy-figma-scene';
export const FIGMA_SCENE_VERSION = 1;

const MAX_TEXT = 2000;
const MAX_NODES = 4000;

function round(n) {
  const v = Number(n);
  return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
}

function parseAttr(tag, name) {
  const re = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`, 'i');
  const m = String(tag).match(re);
  return m ? (m[2] ?? m[3] ?? '') : '';
}

function unescapeXml(v) {
  return String(v ?? '')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseColor(raw) {
  const s = unescapeXml(String(raw || '').trim());
  if (!s || s === 'none' || s.startsWith('url(')) return null;
  return s;
}

function parseOpacity(tag) {
  const raw = parseAttr(tag, 'opacity');
  if (!raw) return 1;
  const n = parseFloat(raw);
  return Number.isFinite(n) ? Math.min(1, Math.max(0, n)) : 1;
}

/**
 * Parse CSS linear-gradient(...) into a scene fill object.
 * @param {string} css
 * @returns {{ type: 'GRADIENT_LINEAR', angle: number, stops: Array<{ color: string, position: number }> } | null}
 */
export function parseCssLinearGradient(css) {
  const m = String(css || '').match(/linear-gradient\((.+)\)/i);
  if (!m) return null;
  const parts = m[1].split(/,(?![^(]*\))/).map((s) => s.trim()).filter(Boolean);
  if (!parts.length) return null;

  let angle = 180;
  let stopParts = parts;
  if (/deg|turn|rad|to\s/i.test(parts[0])) {
    const head = parts[0];
    stopParts = parts.slice(1);
    const deg = head.match(/(-?\d+(?:\.\d+)?)deg/i);
    const turn = head.match(/(-?\d+(?:\.\d+)?)turn/i);
    if (deg) angle = parseFloat(deg[1]);
    else if (turn) angle = parseFloat(turn[1]) * 360;
    else if (/to\s+top\s+right|to\s+right\s+top/i.test(head)) angle = 45;
    else if (/to\s+top\s+left|to\s+left\s+top/i.test(head)) angle = 315;
    else if (/to\s+bottom\s+right|to\s+right\s+bottom/i.test(head)) angle = 135;
    else if (/to\s+bottom\s+left|to\s+left\s+bottom/i.test(head)) angle = 225;
    else if (/to\s+top/i.test(head)) angle = 0;
    else if (/to\s+right/i.test(head)) angle = 90;
    else if (/to\s+bottom/i.test(head)) angle = 180;
    else if (/to\s+left/i.test(head)) angle = 270;
  }
  if (!stopParts.length) return null;

  const stops = stopParts.map((stop, i, arr) => {
    const sm = stop.match(/^(.+?)\s+(\d+(?:\.\d+)?)%$/);
    if (sm) {
      return { color: sm[1].trim(), position: Math.min(1, Math.max(0, parseFloat(sm[2]) / 100)) };
    }
    const pos = arr.length === 1 ? 0 : i / (arr.length - 1);
    return { color: stop.trim(), position: round(pos) };
  }).filter((s) => s.color);

  if (!stops.length) return null;
  return { type: 'GRADIENT_LINEAR', angle: round(angle), stops };
}

function svgGradientAngle(x1, y1, x2, y2) {
  const dx = x2 - x1;
  const dy = y2 - y1;
  // CSS: 0deg = up, 90deg = right
  const deg = (Math.atan2(dx, -dy) * 180) / Math.PI;
  return round(((deg % 360) + 360) % 360);
}

function parseSvgPercent(v, fallback) {
  const s = String(v || '').trim();
  if (!s) return fallback;
  if (s.endsWith('%')) return parseFloat(s) / 100;
  const n = parseFloat(s);
  return Number.isFinite(n) ? (n > 1 ? n / 100 : n) : fallback;
}

/**
 * Collect <linearGradient> defs from SVG source.
 * @param {string} source
 * @returns {Map<string, { type: 'GRADIENT_LINEAR', angle: number, stops: Array<{ color: string, position: number }> }>}
 */
function collectSvgGradients(source) {
  const map = new Map();
  const re = /<linearGradient\b([^>]*)>([\s\S]*?)<\/linearGradient>/gi;
  let m;
  while ((m = re.exec(source))) {
    const attrs = m[1] || '';
    const body = m[2] || '';
    const id = parseAttr(attrs, 'id');
    if (!id) continue;
    const x1 = parseSvgPercent(parseAttr(attrs, 'x1'), 0);
    const y1 = parseSvgPercent(parseAttr(attrs, 'y1'), 0);
    const x2 = parseSvgPercent(parseAttr(attrs, 'x2'), 0);
    const y2 = parseSvgPercent(parseAttr(attrs, 'y2'), 1);
    const stops = [];
    const stopRe = /<stop\b([^>]*)\/?>/gi;
    let sm;
    while ((sm = stopRe.exec(body))) {
      const sa = sm[1] || '';
      const color = parseColor(parseAttr(sa, 'stop-color')) || '#000000';
      const offRaw = parseAttr(sa, 'offset') || '0';
      const position = offRaw.endsWith('%')
        ? Math.min(1, Math.max(0, parseFloat(offRaw) / 100))
        : Math.min(1, Math.max(0, parseFloat(offRaw) || 0));
      stops.push({ color, position: round(position) });
    }
    if (!stops.length) continue;
    map.set(id, {
      type: 'GRADIENT_LINEAR',
      angle: svgGradientAngle(x1, y1, x2, y2),
      stops,
    });
  }
  return map;
}

function resolveFill(rawFill, gradients) {
  const raw = unescapeXml(String(rawFill || '').trim());
  if (!raw || raw === 'none') return null;
  const url = raw.match(/^url\(#([^)]+)\)$/i);
  if (url) return gradients.get(url[1]) || null;
  if (raw.startsWith('url(')) return null;
  return raw;
}

/**
 * Validate a scene object. Throws on structural errors.
 * @param {unknown} scene
 */
export function validateFigmaScene(scene) {
  if (!scene || typeof scene !== 'object') throw new Error('Scene must be an object');
  const s = scene;
  if (s.kind !== FIGMA_SCENE_KIND) throw new Error(`kind must be ${FIGMA_SCENE_KIND}`);
  if (s.version !== FIGMA_SCENE_VERSION) throw new Error(`version must be ${FIGMA_SCENE_VERSION}`);
  if (!s.page || typeof s.page !== 'object') throw new Error('page is required');
  if (!Number.isFinite(s.page.width) || !Number.isFinite(s.page.height)) {
    throw new Error('page.width and page.height must be numbers');
  }
  if (!Array.isArray(s.nodes)) throw new Error('nodes must be an array');
  const allowed = new Set(['FRAME', 'RECT', 'TEXT', 'IMAGE']);

  const walk = (nodes) => {
    for (const node of nodes || []) {
      if (!node || typeof node !== 'object') throw new Error('invalid node');
      if (!allowed.has(node.type)) throw new Error(`unsupported node type: ${node.type}`);
      if (!Number.isFinite(node.x) || !Number.isFinite(node.y) || !Number.isFinite(node.w) || !Number.isFinite(node.h)) {
        throw new Error(`${node.type} is missing geometry`);
      }
      if (node.type === 'TEXT' && typeof node.characters !== 'string') {
        throw new Error('TEXT.characters must be a string');
      }
      if (node.type === 'IMAGE' && typeof node.src !== 'string') {
        throw new Error('IMAGE.src must be a string');
      }
      if (node.type === 'RECT' && node.fill != null) {
        const f = node.fill;
        if (typeof f !== 'string') {
          if (!f || f.type !== 'GRADIENT_LINEAR' || !Array.isArray(f.stops) || !f.stops.length) {
            throw new Error('RECT.fill must be a color string or GRADIENT_LINEAR');
          }
        }
      }
      if (Array.isArray(node.children)) walk(node.children);
    }
  };
  walk(s.nodes);
  return s;
}

/**
 * Keep scene JSON under Storage / Vercel response limits by replacing oversized
 * embedded images with solid placeholder rects (layout preserved).
 */
export function slimFigmaSceneForTransport(scene, maxBytes = 2_500_000) {
  const clone = JSON.parse(JSON.stringify(scene));
  const maxSrc = 120_000;

  const walk = (nodes) => {
    for (const node of nodes || []) {
      if (node.type === 'IMAGE' && typeof node.src === 'string' && node.src.length > maxSrc) {
        node.type = 'RECT';
        node.fill = '#c4c4c4';
        delete node.src;
        delete node.objectFit;
      }
      if (Array.isArray(node.children)) walk(node.children);
    }
  };
  walk(clone.nodes);

  let json = JSON.stringify(clone);
  if (json.length <= maxBytes) return clone;

  // Second pass: drop all remaining data: images.
  const walk2 = (nodes) => {
    for (const node of nodes || []) {
      if (node.type === 'IMAGE' && typeof node.src === 'string' && node.src.startsWith('data:')) {
        node.type = 'RECT';
        node.fill = '#c4c4c4';
        delete node.src;
        delete node.objectFit;
      }
      if (Array.isArray(node.children)) walk2(node.children);
    }
  };
  walk2(clone.nodes);
  return clone;
}

/**
 * Convert Clonyfy scene-graph SVG into Figma Scene Graph v1 JSON.
 * @param {string} svg
 * @param {{ name?: string, route?: string }} [meta]
 */
export function svgToFigmaScene(svg, meta = {}) {
  const source = String(svg || '');
  const svgOpen = source.match(/<svg\b[^>]*>/i)?.[0] || '';
  const viewBox = parseAttr(svgOpen, 'viewBox').split(/[\s,]+/).map(Number);
  const width = round(parseFloat(parseAttr(svgOpen, 'width')) || viewBox[2] || 1440);
  const height = round(parseFloat(parseAttr(svgOpen, 'height')) || viewBox[3] || 900);

  const pageBgMatch = source.match(/<rect\b[^>]*\bid="page-background"[^>]*>/i);
  const pageFill = pageBgMatch ? parseColor(parseAttr(pageBgMatch[0], 'fill')) : '#ffffff';
  const gradients = collectSvgGradients(source);

  /** @type {Array<{ type: string, name: string, x: number, y: number, w: number, h: number, [k: string]: unknown }>} */
  const nodes = [];

  const sectionRe = /<g\b([^>]*\bdata-clonyfy-section\s*=\s*["']true["'][^>]*)>([\s\S]*?)<\/g>/gi;
  let sectionMatch;
  while ((sectionMatch = sectionRe.exec(source))) {
    const attrs = sectionMatch[1] || '';
    const name = unescapeXml(parseAttr(attrs, 'id') || 'Page') || 'Page';
    const body = sectionMatch[2] || '';
    const children = extractNodes(body, gradients);
    if (!children.length) continue;

    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const child of children) {
      minX = Math.min(minX, child.x);
      minY = Math.min(minY, child.y);
      maxX = Math.max(maxX, child.x + child.w);
      maxY = Math.max(maxY, child.y + child.h);
    }
    if (!Number.isFinite(minX)) continue;

    nodes.push({
      type: 'FRAME',
      name,
      x: round(minX),
      y: round(minY),
      w: round(Math.max(1, maxX - minX)),
      h: round(Math.max(1, maxY - minY)),
      children,
    });
    if (nodes.length >= MAX_NODES) break;
  }

  if (!nodes.length) {
    const loose = extractNodes(source, gradients);
    if (loose.length) {
      nodes.push({
        type: 'FRAME',
        name: 'Page',
        x: 0,
        y: 0,
        w: width,
        h: height,
        children: loose,
      });
    }
  }

  if (!nodes.length) {
    throw new Error('Empty scene — SVG had no exportable FRAME/RECT/TEXT/IMAGE layers');
  }

  const scene = {
    kind: FIGMA_SCENE_KIND,
    version: FIGMA_SCENE_VERSION,
    name: String(meta.name || meta.route || 'Clonyfy page'),
    route: meta.route ? String(meta.route) : undefined,
    page: {
      width,
      height,
      fill: pageFill || '#ffffff',
    },
    nodes,
  };

  return validateFigmaScene(scene);
}

function extractNodes(fragment, gradients = new Map()) {
  const nodes = [];
  const source = String(fragment || '');

  const rectRe = /<rect\b[^>]*\/?>/gi;
  let m;
  while ((m = rectRe.exec(source))) {
    const tag = m[0];
    const id = parseAttr(tag, 'id');
    if (id === 'page-background') continue;
    const fillAttr = parseAttr(tag, 'fill');
    const fill = resolveFill(fillAttr, gradients);
    const strokeColor = parseColor(parseAttr(tag, 'stroke'));
    const strokeWidth = round(parseFloat(parseAttr(tag, 'stroke-width')) || 0);
    const w = round(parseFloat(parseAttr(tag, 'width')));
    const h = round(parseFloat(parseAttr(tag, 'height')));
    if (w < 0.5 || h < 0.5) continue;
    if (!fill && !(strokeColor && strokeWidth > 0)) continue;

    /** @type {Record<string, unknown>} */
    const node = {
      type: 'RECT',
      name: unescapeXml(id || 'rect'),
      x: round(parseFloat(parseAttr(tag, 'x'))),
      y: round(parseFloat(parseAttr(tag, 'y'))),
      w,
      h,
      opacity: parseOpacity(tag),
      cornerRadius: round(parseFloat(parseAttr(tag, 'rx')) || 0),
    };
    if (fill) node.fill = fill;
    if (strokeColor && strokeWidth > 0) {
      node.stroke = { color: strokeColor, weight: strokeWidth };
    }
    nodes.push(node);
    if (nodes.length >= MAX_NODES) return nodes;
  }

  const imageRe = /<image\b[^>]*\/?>/gi;
  while ((m = imageRe.exec(source))) {
    const tag = m[0];
    const src = unescapeXml(parseAttr(tag, 'href') || parseAttr(tag, 'xlink:href'));
    if (!src) continue;
    const w = round(parseFloat(parseAttr(tag, 'width')));
    const h = round(parseFloat(parseAttr(tag, 'height')));
    if (w < 0.5 || h < 0.5) continue;
    const par = parseAttr(tag, 'preserveAspectRatio') || 'none';
    let objectFit = 'fill';
    if (/slice/i.test(par)) objectFit = 'cover';
    else if (/meet/i.test(par)) objectFit = 'contain';
    nodes.push({
      type: 'IMAGE',
      name: unescapeXml(parseAttr(tag, 'id') || 'image'),
      x: round(parseFloat(parseAttr(tag, 'x'))),
      y: round(parseFloat(parseAttr(tag, 'y'))),
      w,
      h,
      src,
      opacity: parseOpacity(tag),
      objectFit,
    });
    if (nodes.length >= MAX_NODES) return nodes;
  }

  const textRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi;
  while ((m = textRe.exec(source))) {
    const tag = `<text ${m[1]}>`;
    const characters = unescapeXml(m[2] || '').slice(0, MAX_TEXT);
    if (!characters.trim()) continue;
    const fontSize = round(parseFloat(parseAttr(tag, 'font-size')) || 16);
    const x = round(parseFloat(parseAttr(tag, 'x')));
    const baseline = round(parseFloat(parseAttr(tag, 'y')));
    const y = round(baseline - fontSize * 0.82);
    const letterSpacingRaw = parseAttr(tag, 'letter-spacing');
    const letterSpacing = letterSpacingRaw && letterSpacingRaw !== 'normal'
      ? round(parseFloat(letterSpacingRaw) || 0)
      : 0;
    const textAnchor = parseAttr(tag, 'text-anchor');
    let textAlign = 'LEFT';
    if (textAnchor === 'middle') textAlign = 'CENTER';
    else if (textAnchor === 'end') textAlign = 'RIGHT';
    nodes.push({
      type: 'TEXT',
      name: unescapeXml(parseAttr(tag, 'id') || 'text'),
      x,
      y,
      w: round(Math.max(8, characters.length * fontSize * 0.55)),
      h: round(fontSize * 1.2),
      characters,
      fill: parseColor(parseAttr(tag, 'fill')) || '#000000',
      fontFamily: unescapeXml(parseAttr(tag, 'font-family') || 'Inter') || 'Inter',
      fontSize,
      fontWeight: unescapeXml(parseAttr(tag, 'font-weight') || '400') || '400',
      fontStyle: /italic/i.test(parseAttr(tag, 'font-style') || '') ? 'italic' : 'normal',
      letterSpacing,
      lineHeight: round(fontSize * 1.2),
      textAlign,
      textDecoration: 'none',
      opacity: parseOpacity(tag),
    });
    if (nodes.length >= MAX_NODES) return nodes;
  }

  return nodes;
}

export function countSceneNodes(scene) {
  const walk = (nodes) => {
    let n = 0;
    for (const node of nodes || []) {
      n += 1;
      if (Array.isArray(node.children)) n += walk(node.children);
    }
    return n;
  };
  return walk(scene?.nodes);
}
