/**
 * Clonyfy Import — Figma Development plugin.
 * Receives Scene Graph v1 (optionally chunked) and creates FRAME / RECT / TEXT / IMAGE.
 */

figma.showUI(__html__, { width: 440, height: 560, themeColors: true });

const KIND = 'clonyfy-figma-scene';
const VERSION = 1;
const MAX_NODES = 4000;
const chunkBuffers = new Map();

function parseCssColor(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s || s === 'none' || s === 'transparent') return null;
  if (s.startsWith('url(')) return null;
  if (s[0] === '#') {
    let hex = s.slice(1);
    if (hex.length === 3) hex = hex.split('').map((c) => c + c).join('');
    let alpha = 1;
    if (hex.length === 8) {
      alpha = parseInt(hex.slice(6, 8), 16) / 255;
      hex = hex.slice(0, 6);
    }
    if (hex.length !== 6 || /[^0-9a-f]/i.test(hex)) return null;
    return {
      r: parseInt(hex.slice(0, 2), 16) / 255,
      g: parseInt(hex.slice(2, 4), 16) / 255,
      b: parseInt(hex.slice(4, 6), 16) / 255,
      a: alpha,
    };
  }
  // rgb(1, 2, 3) or rgb(1 2 3 / 0.5)
  let m = s.match(/^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?\s*\)$/);
  if (m) {
    const to = (v) => Math.min(1, Math.max(0, Number(v) / 255));
    return {
      r: to(m[1]),
      g: to(m[2]),
      b: to(m[3]),
      a: m[4] != null ? Math.min(1, Math.max(0, Number(m[4]))) : 1,
    };
  }
  m = s.match(/^rgba?\(\s*([0-9.]+)\s+([0-9.]+)\s+([0-9.]+)(?:\s*\/\s*([0-9.]+))?\s*\)$/);
  if (m) {
    const to = (v) => Math.min(1, Math.max(0, Number(v) / 255));
    return {
      r: to(m[1]),
      g: to(m[2]),
      b: to(m[3]),
      a: m[4] != null ? Math.min(1, Math.max(0, Number(m[4]))) : 1,
    };
  }
  return null;
}

function figmaFontStyle(fontWeight, fontStyle) {
  const italic = String(fontStyle || '').toLowerCase() === 'italic';
  const w = parseInt(String(fontWeight || '400'), 10) || 400;
  let name = 'Regular';
  if (w >= 800) name = 'Extra Bold';
  else if (w >= 700) name = 'Bold';
  else if (w >= 600) name = 'Semi Bold';
  else if (w >= 500) name = 'Medium';
  else if (w <= 300) name = 'Light';
  if (italic && name === 'Regular') return 'Italic';
  if (italic) return `${name} Italic`;
  return name;
}

function relativeBox(node, parent) {
  const px = parent ? Number(parent.x) || 0 : 0;
  const py = parent ? Number(parent.y) || 0 : 0;
  const w = Number(node.w);
  const h = Number(node.h);
  return {
    x: (Number(node.x) || 0) - px,
    y: (Number(node.y) || 0) - py,
    w: Number.isFinite(w) && w > 0 ? w : 1,
    h: Number.isFinite(h) && h > 0 ? h : 1,
  };
}

function imageScaleMode(objectFit) {
  const fit = String(objectFit || 'fill').toLowerCase();
  if (fit === 'contain') return 'FIT';
  return 'FILL';
}

function cssAngleToGradientTransform(angleDeg) {
  const angle = ((Number(angleDeg) || 0) % 360 + 360) % 360;
  const rad = ((angle - 90) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [
    [cos, -sin, 0.5 - cos * 0.5 + sin * 0.5],
    [sin, cos, 0.5 - sin * 0.5 - cos * 0.5],
  ];
}

function solidPaint(css, opacity) {
  const rgba = parseCssColor(css) || { r: 0, g: 0, b: 0, a: 1 };
  const paint = { type: 'SOLID', color: { r: rgba.r, g: rgba.g, b: rgba.b } };
  const colorA = Number.isFinite(rgba.a) ? rgba.a : 1;
  const op = Number(opacity);
  const combined = colorA * (Number.isFinite(op) ? Math.min(1, Math.max(0, op)) : 1);
  if (combined < 0.999) paint.opacity = combined;
  return paint;
}

function gradientPaint(fill, opacity) {
  const stops = Array.isArray(fill.stops) ? fill.stops : [];
  const gradientStops = stops.map((stop) => {
    const rgba = parseCssColor(stop.color) || { r: 0, g: 0, b: 0, a: 1 };
    const colorA = Number.isFinite(rgba.a) ? rgba.a : 1;
    const op = Number(opacity);
    const a = colorA * (Number.isFinite(op) ? Math.min(1, Math.max(0, op)) : 1);
    return {
      position: Math.min(1, Math.max(0, Number(stop.position) || 0)),
      color: { r: rgba.r, g: rgba.g, b: rgba.b, a },
    };
  });
  if (gradientStops.length < 2) {
    const c = gradientStops[0] && gradientStops[0].color
      ? gradientStops[0].color
      : { r: 0, g: 0, b: 0, a: 1 };
    return solidPaint('rgb(' + (c.r * 255) + ',' + (c.g * 255) + ',' + (c.b * 255) + ')', c.a);
  }
  return {
    type: 'GRADIENT_LINEAR',
    gradientTransform: cssAngleToGradientTransform(fill.angle),
    gradientStops,
  };
}

function fillsFromSpec(fill, opacity) {
  if (fill == null || fill === '') return [];
  if (typeof fill === 'string') return [solidPaint(fill, opacity)];
  if (fill && fill.type === 'GRADIENT_LINEAR') {
    try {
      return [gradientPaint(fill, opacity)];
    } catch (err) {
      const fallback = fill.stops && fill.stops[0] && fill.stops[0].color
        ? fill.stops[0].color
        : '#888888';
      return [solidPaint(fallback, opacity)];
    }
  }
  return [];
}

function strokesFromSpec(stroke, opacity) {
  if (!stroke || !stroke.color) return [];
  const weight = Number(stroke.weight) || 0;
  if (weight <= 0) return [];
  return [solidPaint(stroke.color, opacity)];
}

function safeResize(node, w, h) {
  const ww = Math.max(1, w);
  const hh = Math.max(1, h);
  try {
    if (typeof node.resizeWithoutConstraints === 'function') {
      node.resizeWithoutConstraints(ww, hh);
    } else {
      node.resize(ww, hh);
    }
  } catch {
    try { node.resize(ww, hh); } catch { /* ignore */ }
  }
}

function applyCornerRadii(rect, spec) {
  if (spec.cornerRadii && typeof spec.cornerRadii === 'object') {
    const c = spec.cornerRadii;
    rect.topLeftRadius = Math.max(0, Number(c.tl) || 0);
    rect.topRightRadius = Math.max(0, Number(c.tr) || 0);
    rect.bottomRightRadius = Math.max(0, Number(c.br) || 0);
    rect.bottomLeftRadius = Math.max(0, Number(c.bl) || 0);
    return;
  }
  const radius = Number(spec.cornerRadius) || 0;
  if (radius > 0) rect.cornerRadius = radius;
}

function applyStroke(node, spec) {
  const strokes = strokesFromSpec(spec.stroke, spec.opacity);
  if (!strokes.length) {
    node.strokes = [];
    return;
  }
  node.strokes = strokes;
  node.strokeWeight = Math.max(0.01, Number(spec.stroke.weight) || 1);
  try { node.strokeAlign = 'INSIDE'; } catch { /* ignore */ }
}

function validateScene(scene) {
  if (!scene || typeof scene !== 'object') throw new Error('Paste a JSON object');
  if (scene.kind !== KIND) throw new Error(`Not a Clonyfy scene (kind must be ${KIND})`);
  if (scene.version !== VERSION) throw new Error(`Unsupported scene version ${scene.version}`);
  if (!scene.page || !Number.isFinite(Number(scene.page.width)) || !Number.isFinite(Number(scene.page.height))) {
    throw new Error('Scene is missing page.width / page.height');
  }
  if (!Array.isArray(scene.nodes)) throw new Error('Scene is missing nodes[]');
}

const fontCache = new Map();

async function loadFont(family, style) {
  const key = `${family}::${style}`;
  if (fontCache.has(key)) return fontCache.get(key);
  const candidates = [
    { family: 'Inter', style },
    { family: 'Inter', style: 'Regular' },
    { family, style },
    { family: 'Roboto', style: 'Regular' },
  ];
  let lastErr;
  for (const font of candidates) {
    const ck = `${font.family}::${font.style}`;
    if (fontCache.has(ck)) {
      fontCache.set(key, fontCache.get(ck));
      return fontCache.get(ck);
    }
    try {
      await figma.loadFontAsync(font);
      fontCache.set(ck, font);
      fontCache.set(key, font);
      return font;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr || new Error('Could not load a fallback font');
}

function decodeDataUrl(src) {
  const m = String(src).match(/^data:([^;]+);base64,(.+)$/);
  if (!m) return null;
  const b64 = m[2];
  if (typeof figma.base64Decode === 'function') return figma.base64Decode(b64);
  return null;
}

async function bytesFromSrc(src) {
  if (!src) throw new Error('IMAGE is missing src');
  if (String(src).startsWith('__skipped__')) throw new Error('Image skipped (payload too large)');
  const data = decodeDataUrl(src);
  if (data) return data;
  const res = await fetch(src);
  if (!res.ok) throw new Error(`Image fetch failed (${res.status})`);
  const buf = await res.arrayBuffer();
  return new Uint8Array(buf);
}

async function paintImage(node, src, objectFit, opacity) {
  const bytes = await bytesFromSrc(src);
  const image = figma.createImage(bytes);
  const paint = {
    type: 'IMAGE',
    imageHash: image.hash,
    scaleMode: imageScaleMode(objectFit),
  };
  const op = Number(opacity);
  if (Number.isFinite(op) && op < 0.999) paint.opacity = Math.min(1, Math.max(0, op));
  node.fills = [paint];
}

let created = 0;

async function createNode(spec, parentFigma, parentSpec) {
  if (!spec || created >= MAX_NODES) return null;
  try {
    const box = relativeBox(spec, parentSpec);
    const type = spec.type;

    if (type === 'FRAME') {
      const frame = figma.createFrame();
      frame.name = String(spec.name || 'Frame').slice(0, 100);
      frame.x = box.x;
      frame.y = box.y;
      safeResize(frame, box.w, box.h);
      frame.fills = [];
      frame.clipsContent = false;
      parentFigma.appendChild(frame);
      created += 1;
      const kids = Array.isArray(spec.children) ? spec.children : [];
      for (const child of kids) {
        await createNode(child, frame, spec);
      }
      return frame;
    }

    if (type === 'RECT') {
      const rect = figma.createRectangle();
      rect.name = String(spec.name || 'Rect').slice(0, 100);
      rect.x = box.x;
      rect.y = box.y;
      safeResize(rect, box.w, box.h);
      try { applyCornerRadii(rect, spec); } catch { /* ignore */ }
      try { rect.fills = fillsFromSpec(spec.fill, spec.opacity); } catch { rect.fills = []; }
      try { applyStroke(rect, spec); } catch { /* ignore */ }
      parentFigma.appendChild(rect);
      created += 1;
      return rect;
    }

    if (type === 'TEXT') {
      const text = figma.createText();
      text.name = String(spec.name || 'Text').slice(0, 100);
      text.x = box.x;
      text.y = box.y;
      const font = await loadFont(String(spec.fontFamily || 'Inter'), figmaFontStyle(spec.fontWeight, spec.fontStyle));
      text.fontName = font;
      text.characters = String(spec.characters || ' ').slice(0, 2000) || ' ';
      text.fontSize = Number(spec.fontSize) || 16;
      try {
        const spacing = Number(spec.letterSpacing);
        if (Number.isFinite(spacing) && spacing !== 0) {
          text.letterSpacing = { unit: 'PIXELS', value: spacing };
        }
      } catch { /* ignore */ }
      try {
        const lh = Number(spec.lineHeight);
        if (Number.isFinite(lh) && lh > 0) {
          text.lineHeight = { unit: 'PIXELS', value: lh };
        }
      } catch { /* ignore */ }
      try {
        const align = String(spec.textAlign || 'LEFT').toUpperCase();
        if (align === 'CENTER' || align === 'RIGHT' || align === 'JUSTIFIED' || align === 'LEFT') {
          text.textAlignHorizontal = align;
        }
      } catch { /* ignore */ }
      try {
        if (String(spec.textDecoration || '').toLowerCase() === 'underline') {
          text.textDecoration = 'UNDERLINE';
        }
      } catch { /* ignore */ }
      try { text.fills = fillsFromSpec(spec.fill || '#000000', spec.opacity); } catch { /* ignore */ }
      safeResize(text, box.w, box.h);
      parentFigma.appendChild(text);
      created += 1;
      return text;
    }

    if (type === 'IMAGE') {
      const rect = figma.createRectangle();
      rect.name = String(spec.name || 'Image').slice(0, 100);
      rect.x = box.x;
      rect.y = box.y;
      safeResize(rect, box.w, box.h);
      try { applyCornerRadii(rect, spec); } catch { /* ignore */ }
      parentFigma.appendChild(rect);
      created += 1;
      try {
        await paintImage(rect, spec.src, spec.objectFit, spec.opacity);
      } catch {
        rect.fills = [{ type: 'SOLID', color: { r: 0.9, g: 0.9, b: 0.9 } }];
        rect.name = `${rect.name} (image skipped)`;
      }
      return rect;
    }
  } catch {
    /* skip broken node */
  }
  return null;
}

async function importScene(scene) {
  validateScene(scene);
  created = 0;
  await figma.loadFontAsync({ family: 'Inter', style: 'Regular' }).catch(() => {});

  const pageW = Math.max(1, Number(scene.page.width) || 1);
  const pageH = Math.max(1, Number(scene.page.height) || 1);
  const root = figma.createFrame();
  root.name = String(scene.name || scene.route || 'Clonyfy page').slice(0, 100);
  root.x = 40;
  root.y = 40;
  safeResize(root, pageW, pageH);
  root.clipsContent = true;
  const pageFill = parseCssColor(scene.page.fill);
  root.fills = pageFill
    ? [{ type: 'SOLID', color: { r: pageFill.r, g: pageFill.g, b: pageFill.b } }]
    : [{ type: 'SOLID', color: { r: 1, g: 1, b: 1 } }];
  figma.currentPage.appendChild(root);
  created += 1;

  const pageSpec = { x: 0, y: 0, w: pageW, h: pageH };
  const nodes = Array.isArray(scene.nodes) ? scene.nodes : [];
  for (let i = 0; i < nodes.length; i++) {
    await createNode(nodes[i], root, pageSpec);
    if (i % 8 === 0) {
      figma.ui.postMessage({ type: 'progress', message: `${created} layers` });
    }
  }

  figma.currentPage.selection = [root];
  figma.viewport.scrollAndZoomIntoView([root]);
  return created;
}

async function handleImportScene(scene) {
  figma.ui.postMessage({ type: 'received' });
  try {
    const count = await importScene(scene);
    figma.ui.postMessage({ type: 'ok', count });
    figma.notify(`Imported ${count} layers`);
  } catch (err) {
    const message = err && err.message ? err.message : String(err);
    figma.ui.postMessage({ type: 'error', message });
    figma.notify(message.slice(0, 120), { error: true });
  }
}

figma.ui.onmessage = async (msg) => {
  if (!msg || typeof msg !== 'object') return;

  if (msg.type === 'ping') {
    figma.ui.postMessage({ type: 'pong' });
    return;
  }

  if (msg.type === 'get-auto-import') {
    try {
      const value = await figma.clientStorage.getAsync('clonyfy_auto_import');
      figma.ui.postMessage({ type: 'auto-import', value: value !== false });
    } catch (err) {
      figma.ui.postMessage({ type: 'auto-import', value: true });
    }
    return;
  }

  if (msg.type === 'set-auto-import') {
    try {
      await figma.clientStorage.setAsync('clonyfy_auto_import', msg.value !== false);
    } catch (err) {
      /* ignore */
    }
    return;
  }

  if (msg.type === 'import-scene') {
    try {
      const scene = typeof msg.scene === 'string' ? JSON.parse(msg.scene) : msg.scene;
      await handleImportScene(scene);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      figma.ui.postMessage({ type: 'error', message: 'Failed to parse scene: ' + message });
    }
    return;
  }

  // Chunked transfer for large clipboard scenes (avoids silent postMessage failures).
  if (msg.type === 'import-scene-start') {
    chunkBuffers.set(msg.id, { chunks: Number(msg.chunks) || 0, parts: [], received: 0 });
    figma.ui.postMessage({ type: 'progress', message: 'Receiving scene…' });
    return;
  }
  if (msg.type === 'import-scene-chunk') {
    const buf = chunkBuffers.get(msg.id);
    if (!buf) return;
    buf.parts[msg.index] = String(msg.data || '');
    buf.received += 1;
    if (buf.received % 5 === 0) {
      figma.ui.postMessage({ type: 'progress', message: `Receiving… ${buf.received}/${buf.chunks}` });
    }
    return;
  }
  if (msg.type === 'import-scene-end') {
    const buf = chunkBuffers.get(msg.id);
    chunkBuffers.delete(msg.id);
    if (!buf) {
      figma.ui.postMessage({ type: 'error', message: 'Chunk buffer missing — click Import again.' });
      return;
    }
    try {
      const raw = buf.parts.join('');
      const scene = JSON.parse(raw);
      await handleImportScene(scene);
    } catch (err) {
      const message = err && err.message ? err.message : String(err);
      figma.ui.postMessage({ type: 'error', message: 'Chunk reassembly failed: ' + message });
    }
  }
};
