/** Keep in sync with the copies inside code.js (Figma cannot import this file). */

export function parseCssColor(raw) {
  const s = String(raw || '').trim().toLowerCase();
  if (!s || s === 'none' || s === 'transparent') return null;
  if (s.startsWith('url(')) return null;

  if (s[0] === '#') {
    let hex = s.slice(1);
    if (hex.length === 3) {
      hex = hex.split('').map((c) => c + c).join('');
    }
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

  const m = s.match(/^rgba?\(\s*([0-9.]+)\s*,\s*([0-9.]+)\s*,\s*([0-9.]+)(?:\s*,\s*([0-9.]+))?/);
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

export function figmaFontStyle(fontWeight, fontStyle) {
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

export function relativeBox(node, parent) {
  const px = parent ? Number(parent.x) || 0 : 0;
  const py = parent ? Number(parent.y) || 0 : 0;
  return {
    x: (Number(node.x) || 0) - px,
    y: (Number(node.y) || 0) - py,
    w: Math.max(1, Number(node.w) || 1),
    h: Math.max(1, Number(node.h) || 1),
  };
}

export function imageScaleMode(objectFit) {
  const fit = String(objectFit || 'fill').toLowerCase();
  if (fit === 'contain') return 'FIT';
  return 'FILL';
}

/**
 * CSS linear-gradient angle (0° = to top, 90° = to right)
 * → Figma gradientTransform (2×3).
 */
export function cssAngleToGradientTransform(angleDeg) {
  const angle = ((Number(angleDeg) || 0) % 360 + 360) % 360;
  const rad = ((angle - 90) * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return [
    [cos, -sin, 0.5 - cos * 0.5 + sin * 0.5],
    [sin, cos, 0.5 - sin * 0.5 - cos * 0.5],
  ];
}
