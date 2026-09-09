/**
 * Clonyfy Scene Graph exporter (no screenshots).
 * format: "svg" (default) | "scene" — scene returns Figma Scene Graph v1 JSON.
 * Step 5: linear gradients, strokes, corner radii, richer text metrics.
 */
export default async function figmaExportPage(options = {}) {
  const viewportWidth = Number(options.viewportWidth) || 1440;
  const maxLayers = Math.min(Math.max(Number(options.maxLayers) || 4500, 500), 8000);
  const maxEmbeddedImageBytes = Math.min(
    Math.max(Number(options.maxEmbeddedImageBytes) || 180_000, 24_000),
    1_200_000,
  );
  const format = options.format === 'scene' ? 'scene' : 'svg';
  let embeddedImageBudget = Math.min(
    Math.max(Number(options.embeddedImageBudget) || (maxEmbeddedImageBytes * 12), maxEmbeddedImageBytes),
    4_000_000,
  );

  function svgEsc(v) {
    return String(v ?? '').replace(/[&<>"']/g, (ch) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;',
    }[ch]));
  }

  function num(v) {
    return Number.isFinite(v) ? Math.round(v * 100) / 100 : 0;
  }

  function parseAlpha(color) {
    if (!color || color === 'transparent') return 0;
    const m = String(color).match(/rgba?\([^)]+\)/);
    if (!m) return 1;
    const parts = m[0].replace(/rgba?\(|\)/g, '').split(',').map((s) => s.trim());
    if (parts.length === 4) return parseFloat(parts[3]) || 0;
    return 1;
  }

  function isVisible(cs) {
    if (!cs) return false;
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    if (parseFloat(cs.opacity || '1') <= 0.02) return false;
    return true;
  }

  function skipRoot(el) {
    if (!el || el.nodeType !== 1) return true;
    if (el.closest('script,style,noscript,template,iframe,#__ce__,[data-clonyfy-scroll-reveal],[data-clonyfy-preview-nav],[data-clonyfy-share-nav]')) return true;
    if (el.id === 'clonyfy-scroll-reveal-style' || el.id === '__clonyfy_figma_hide__') return true;
    return false;
  }

  /** Undo Clonyfy scroll-reveal opacity:0 so layers are exportable. */
  function forceRevealForExport() {
    try {
      document.querySelectorAll('.clonyfy-reveal').forEach((el) => {
        el.classList.add('clonyfy-in');
        el.style.setProperty('opacity', '1', 'important');
        el.style.setProperty('transform', 'none', 'important');
      });
      const style = document.getElementById('clonyfy-scroll-reveal-style');
      if (style) style.remove();
      // Captured pages often keep opacity:0 / visibility:hidden from the live site.
      document.querySelectorAll('[style*="opacity"]').forEach((el) => {
        try {
          if (parseFloat(el.style.opacity || '1') <= 0.05) el.style.setProperty('opacity', '1', 'important');
        } catch {}
      });
      document.querySelectorAll('[style*="visibility"]').forEach((el) => {
        try {
          if (/hidden/i.test(el.style.visibility || '')) el.style.setProperty('visibility', 'visible', 'important');
        } catch {}
      });
      document.documentElement.style.setProperty('opacity', '1', 'important');
      document.documentElement.style.setProperty('visibility', 'visible', 'important');
      if (document.body) {
        document.body.style.setProperty('opacity', '1', 'important');
        document.body.style.setProperty('visibility', 'visible', 'important');
      }
    } catch {}
  }

  function layerId(el, suffix = '') {
    const base = el.getAttribute('data-framer-name')
      || el.getAttribute('aria-label')
      || el.id
      || el.tagName.toLowerCase();
    const clean = String(base).replace(/[^a-zA-Z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'layer';
    return `${clean}${suffix}`;
  }

  function absRect(el) {
    const r = el.getBoundingClientRect();
    return {
      x: num(r.left + window.scrollX),
      y: num(r.top + window.scrollY),
      w: num(r.width),
      h: num(r.height),
    };
  }

  function radii(cs) {
    const tl = parseFloat(cs.borderTopLeftRadius) || 0;
    const tr = parseFloat(cs.borderTopRightRadius) || 0;
    const br = parseFloat(cs.borderBottomRightRadius) || 0;
    const bl = parseFloat(cs.borderBottomLeftRadius) || 0;
    if (tl === tr && tr === br && br === bl) return { rx: tl, uniform: true };
    return { tl, tr, br, bl, uniform: false, rx: Math.max(tl, tr, br, bl) };
  }

  function bgImageUrl(bg) {
    const s = String(bg || '');
    if (!s || s === 'none') return '';
    const m = s.match(/url\(["']?([^"')]+)["']?\)/);
    return m ? m[1] : '';
  }

  function hasGradient(bg) {
    return /gradient\(/i.test(String(bg || ''));
  }

  async function inlineImage(src, maxBytes = maxEmbeddedImageBytes) {
    if (!src || src.startsWith('data:')) return src || '';
    if (embeddedImageBudget <= 0) return '';
    try {
      const abs = new URL(src, document.baseURI || location.href).href;
      const res = await fetch(abs, { credentials: 'omit' });
      if (!res.ok) return '';
      const blob = await res.blob();
      if (!blob.size) return '';
      // Prefer downscaled JPEG so scene JSON stays under Storage/API limits.
      if (typeof createImageBitmap === 'function' && /^image\/(png|jpeg|jpg|webp|gif)/i.test(blob.type || 'image/png')) {
        try {
          const bmp = await createImageBitmap(blob);
          const maxEdge = maxBytes <= 200_000 ? 640 : 960;
          const scale = Math.min(1, maxEdge / Math.max(bmp.width, bmp.height, 1));
          const w = Math.max(1, Math.round(bmp.width * scale));
          const h = Math.max(1, Math.round(bmp.height * scale));
          const canvas = document.createElement('canvas');
          canvas.width = w;
          canvas.height = h;
          const ctx = canvas.getContext('2d');
          if (ctx) {
            ctx.drawImage(bmp, 0, 0, w, h);
            try { bmp.close(); } catch {}
            let quality = maxBytes <= 200_000 ? 0.58 : 0.72;
            let out = canvas.toDataURL('image/jpeg', quality);
            while (out.length > maxBytes * 1.37 && quality > 0.35) {
              quality -= 0.1;
              out = canvas.toDataURL('image/jpeg', quality);
            }
            if (out.length <= maxBytes * 1.37) {
              embeddedImageBudget -= out.length;
              return out;
            }
          }
        } catch {}
      }
      if (blob.size > maxBytes) return '';
      return await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => {
          const result = String(reader.result || '');
          if (result.length > maxBytes * 1.37) {
            resolve('');
            return;
          }
          embeddedImageBudget -= result.length;
          resolve(result);
        };
        reader.onerror = reject;
        reader.readAsDataURL(blob);
      });
    } catch {
      return '';
    }
  }

  function applyTextTransform(text, transform) {
    const t = String(transform || '').toLowerCase();
    if (t === 'uppercase') return text.toUpperCase();
    if (t === 'lowercase') return text.toLowerCase();
    if (t === 'capitalize') return text.replace(/\b\w/g, (c) => c.toUpperCase());
    return text;
  }

  function splitTextLines(text, rects, cs) {
    if (!rects.length) return [];
    if (rects.length === 1) return [{ text, rect: rects[0] }];
    try {
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      if (!ctx) return [{ text, rect: rects[0] }];
      ctx.font = `${cs.fontStyle || 'normal'} ${cs.fontWeight || '400'} ${cs.fontSize || '16px'} ${cs.fontFamily || 'sans-serif'}`;
      const words = String(text).split(/\s+/).filter(Boolean);
      const lines = [];
      let wi = 0;
      for (let li = 0; li < rects.length; li++) {
        const maxW = Math.max(4, rects[li].width + 1);
        const chunk = [];
        while (wi < words.length) {
          const trial = chunk.length ? `${chunk.join(' ')} ${words[wi]}` : words[wi];
          if (chunk.length && ctx.measureText(trial).width > maxW) break;
          chunk.push(words[wi++]);
        }
        if (li === rects.length - 1 && wi < words.length) chunk.push(...words.slice(wi));
        if (chunk.length) lines.push({ text: chunk.join(' '), rect: rects[li] });
      }
      return lines.length ? lines : [{ text, rect: rects[0] }];
    } catch {
      return [{ text, rect: rects[0] }];
    }
  }

  const defs = [];
  const gradCache = new Map();
  let gradSeq = 0;

  function parseLinearGradient(css, id) {
    const m = String(css).match(/linear-gradient\((.+)\)/i);
    if (!m) return null;
    const inner = m[1];
    const parts = inner.split(/,(?![^(]*\))/).map((s) => s.trim());
    let angle = 180;
    let stops = parts;
    if (/deg|to /.test(parts[0])) {
      const head = parts[0];
      stops = parts.slice(1);
      const deg = head.match(/(-?\d+(?:\.\d+)?)deg/);
      if (deg) angle = parseFloat(deg[1]);
      else if (/to top/i.test(head)) angle = 0;
      else if (/to right/i.test(head)) angle = 90;
      else if (/to bottom/i.test(head)) angle = 180;
      else if (/to left/i.test(head)) angle = 270;
    }
    const rad = (angle - 90) * (Math.PI / 180);
    const x1 = 50 - Math.cos(rad) * 50;
    const y1 = 50 - Math.sin(rad) * 50;
    const x2 = 50 + Math.cos(rad) * 50;
    const y2 = 50 + Math.sin(rad) * 50;
    const stopSvg = stops.map((stop) => {
      const sm = stop.match(/^(.+?)\s+(\d+(?:\.\d+)?%)/);
      if (sm) return `<stop offset="${sm[2]}" stop-color="${svgEsc(sm[1].trim())}"/>`;
      return `<stop offset="0%" stop-color="${svgEsc(stop)}"/>`;
    }).join('');
    return `<linearGradient id="${id}" x1="${num(x1)}%" y1="${num(y1)}%" x2="${num(x2)}%" y2="${num(y2)}%">${stopSvg}</linearGradient>`;
  }

  function gradientRef(css) {
    const key = String(css);
    if (gradCache.has(key)) return gradCache.get(key);
    const id = `g${++gradSeq}`;
    const linear = parseLinearGradient(css, id);
    if (linear) {
      defs.push(linear);
      gradCache.set(key, id);
      return id;
    }
    gradCache.set(key, null);
    return null;
  }

  function firstGradientStopColor(css) {
    const parsed = parseCssLinearGradientFill(css);
    return parsed?.stops?.[0]?.color || null;
  }

  /** @returns {{ type: 'GRADIENT_LINEAR', angle: number, stops: Array<{ color: string, position: number }> } | null} */
  function parseCssLinearGradientFill(css) {
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
      return { color: stop.trim(), position: num(pos) };
    }).filter((s) => s.color);
    if (!stops.length) return null;
    return { type: 'GRADIENT_LINEAR', angle: num(angle), stops };
  }

  function parseLineHeightPx(cs, fontSize) {
    const raw = String(cs.lineHeight || '').trim();
    if (!raw || raw === 'normal') return num(fontSize * 1.2);
    if (raw.endsWith('px')) return num(parseFloat(raw) || fontSize * 1.2);
    if (raw.endsWith('%')) return num((parseFloat(raw) / 100) * fontSize);
    const n = parseFloat(raw);
    if (!Number.isFinite(n)) return num(fontSize * 1.2);
    // unitless multiplier (e.g. 1.5)
    if (n > 0 && n <= 10 && !/[a-z%]/i.test(raw)) return num(n * fontSize);
    return num(n);
  }

  function mapTextAlign(cs) {
    const a = String(cs.textAlign || 'left').toLowerCase();
    if (a === 'center') return 'CENTER';
    if (a === 'right' || a === 'end') return 'RIGHT';
    if (a === 'justify') return 'JUSTIFIED';
    return 'LEFT';
  }

  function mapTextDecoration(cs) {
    const td = String(cs.textDecorationLine || cs.textDecoration || '').toLowerCase();
    return td.includes('underline') ? 'underline' : 'none';
  }

  async function expandLazyContent() {
    document.querySelectorAll('[style*="content-visibility"]').forEach((el) => {
      try { el.style.setProperty('content-visibility', 'visible', 'important'); } catch {}
    });
    document.querySelectorAll('img[loading="lazy"]').forEach((img) => {
      try { img.loading = 'eager'; } catch {}
    });
    document.querySelectorAll('[data-src],[data-lazy-src]').forEach((el) => {
      const real = el.getAttribute('data-src') || el.getAttribute('data-lazy-src');
      if (real && el.tagName === 'IMG' && !el.getAttribute('src')) el.setAttribute('src', real);
    });
    try {
      const h = document.documentElement;
      ['loading', 'no-js', 'is-loading', 'preload'].forEach((c) => h.classList.remove(c));
      h.classList.add('js', 'clonyfy-preview');
      document.querySelectorAll('[style*="opacity:0"],[style*="opacity: 0"]').forEach((el) => {
        if (el.getAttribute('aria-hidden') === 'true') return;
        const r = el.getBoundingClientRect();
        if (r.width >= 2 && r.height >= 2) el.style.opacity = '1';
      });
      document.querySelectorAll('[style*="visibility:hidden"],[style*="visibility: hidden"]').forEach((el) => {
        if (el.getAttribute('aria-hidden') === 'true') return;
        el.style.visibility = 'visible';
      });
    } catch {}
    const delay = (ms) => new Promise((r) => setTimeout(r, ms));
    const step = Math.max(window.innerHeight, 700);
    const maxY = Math.min(document.documentElement.scrollHeight, 32000);
    for (let y = 0; y <= maxY; y += step) {
      window.scrollTo(0, y);
      await delay(45);
    }
    window.scrollTo(0, 0);
    await delay(120);
  }

  await expandLazyContent();

  const width = Math.ceil(Math.max(
    document.documentElement.scrollWidth,
    document.body?.scrollWidth || 0,
    viewportWidth,
    320,
  ));
  const height = Math.ceil(Math.max(
    document.documentElement.scrollHeight,
    document.body?.scrollHeight || 0,
    320,
  ));

  const layers = [];
  let paintOrder = 0;
  const seenText = new Set();
  const seenBgImage = new Set();

  function pushLayer(group, id, svg, kind, sceneNode = null) {
    if (!svg && !sceneNode) return;
    layers.push({ order: paintOrder++, group, id, svg, kind, sceneNode });
  }

  function rectScene(name, r, fill, opacity, radOrRx, extras = {}) {
    const node = {
      type: 'RECT',
      name: String(name || 'rect').slice(0, 80),
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
      opacity: Number.isFinite(opacity) ? opacity : 1,
    };
    if (fill != null && fill !== '') node.fill = fill;
    if (extras.stroke) node.stroke = extras.stroke;
    if (radOrRx && typeof radOrRx === 'object' && radOrRx.uniform === false) {
      node.cornerRadii = {
        tl: num(radOrRx.tl || 0),
        tr: num(radOrRx.tr || 0),
        br: num(radOrRx.br || 0),
        bl: num(radOrRx.bl || 0),
      };
      node.cornerRadius = num(radOrRx.rx || 0);
    } else {
      const rx = typeof radOrRx === 'object' ? (radOrRx.rx || 0) : (radOrRx || 0);
      node.cornerRadius = Number(rx) || 0;
    }
    return node;
  }

  function rectAttrs(r, cs, id, fill, extra = '') {
    const rad = radii(cs);
    const op = parseFloat(cs.opacity || '1');
    const opacity = op < 0.999 ? ` opacity="${num(op)}"` : '';
    const rx = rad.rx || 0;
    if (rx > 0) {
      return `<rect id="${svgEsc(id)}" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="${num(rx)}" fill="${fill}"${opacity}${extra}/>`;
    }
    return `<rect id="${svgEsc(id)}" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" fill="${fill}"${opacity}${extra}/>`;
  }

  async function paintBackground(el, cs, r, group) {
    if (r.w < 1 || r.h < 1) return;
    const bgImg = cs.backgroundImage;
    const bgColor = cs.backgroundColor;
    const hasColor = parseAlpha(bgColor) > 0.04;
    const url = bgImageUrl(bgImg);
    const gradId = hasGradient(bgImg) ? gradientRef(bgImg) : null;
    const op = parseFloat(cs.opacity || '1');
    const rad = radii(cs);

    // CSS paints background-color under background-image (including gradients).
    if (hasColor) {
      pushLayer(
        group,
        `${layerId(el)}-fill`,
        rectAttrs(r, cs, `${layerId(el)}-fill`, svgEsc(bgColor)),
        'fill',
        rectScene(`${layerId(el)}-fill`, r, bgColor, op, rad),
      );
    }

    if (gradId) {
      const gradientFill = parseCssLinearGradientFill(bgImg);
      pushLayer(
        group,
        `${layerId(el)}-gradient`,
        rectAttrs(r, cs, `${layerId(el)}-gradient`, `url(#${gradId})`),
        'fill',
        gradientFill
          ? rectScene(`${layerId(el)}-gradient`, r, gradientFill, op, rad)
          : rectScene(`${layerId(el)}-gradient`, r, firstGradientStopColor(bgImg) || '#000000', op, rad),
      );
    }

    if (url && !url.startsWith('data:image/svg')) {
      const key = `${url}@${Math.round(r.x)}@${Math.round(r.y)}@${Math.round(r.w)}x${Math.round(r.h)}`;
      if (!seenBgImage.has(key)) {
        seenBgImage.add(key);
        const href = await inlineImage(url);
        const opacity = op < 0.999 ? ` opacity="${num(op)}"` : '';
        pushLayer(
          group,
          `${layerId(el)}-bgimg`,
          `<image id="${svgEsc(layerId(el))}-bgimg" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" href="${svgEsc(href)}" xlink:href="${svgEsc(href)}" preserveAspectRatio="xMidYMid slice"${opacity}/>`,
          'image',
          {
            type: 'IMAGE',
            name: `${layerId(el)}-bgimg`,
            x: r.x,
            y: r.y,
            w: r.w,
            h: r.h,
            src: href,
            opacity: op,
            objectFit: 'cover',
          },
        );
      }
    }
  }

  function paintBorder(el, cs, r, group) {
    const bw = Math.max(
      parseFloat(cs.borderTopWidth) || 0,
      parseFloat(cs.borderRightWidth) || 0,
      parseFloat(cs.borderBottomWidth) || 0,
      parseFloat(cs.borderLeftWidth) || 0,
    );
    if (bw <= 0 || cs.borderTopStyle === 'none') return;
    const color = cs.borderTopColor || cs.borderColor;
    if (parseAlpha(color) <= 0.04) return;
    const rad = radii(cs);
    const rx = rad.rx || 0;
    const op = parseFloat(cs.opacity || '1');
    const opacity = op < 0.999 ? ` opacity="${num(op)}"` : '';
    pushLayer(
      group,
      `${layerId(el)}-border`,
      `<rect id="${svgEsc(layerId(el))}-border" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" rx="${num(rx)}" fill="none" stroke="${svgEsc(color)}" stroke-width="${num(bw)}"${opacity}/>`,
      'stroke',
      rectScene(`${layerId(el)}-border`, r, null, op, rad, {
        stroke: { color, weight: num(bw) },
      }),
    );
  }

  async function paintPseudo(el, pseudo, group) {
    const cs = getComputedStyle(el, pseudo);
    if (!cs || cs.content === 'none' || cs.content === 'normal') return;
    if (!isVisible(cs)) return;
    const r = absRect(el);
    if (r.w < 1 || r.h < 1) return;
    const url = bgImageUrl(cs.backgroundImage);
    const op = parseFloat(cs.opacity || '1');
    if (url) {
      const href = await inlineImage(url);
      pushLayer(
        group,
        `${layerId(el)}-${pseudo}-img`,
        `<image x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" href="${svgEsc(href)}" xlink:href="${svgEsc(href)}" preserveAspectRatio="xMidYMid slice"/>`,
        'pseudo',
        {
          type: 'IMAGE',
          name: `${layerId(el)}-${pseudo}`,
          x: r.x,
          y: r.y,
          w: r.w,
          h: r.h,
          src: href,
          opacity: op,
          objectFit: 'cover',
        },
      );
    }
    if (parseAlpha(cs.backgroundColor) > 0.04) {
      const rad = radii(cs);
      pushLayer(
        group,
        `${layerId(el)}-${pseudo}-fill`,
        rectAttrs(r, cs, `${layerId(el)}-${pseudo}`, svgEsc(cs.backgroundColor)),
        'pseudo',
        rectScene(`${layerId(el)}-${pseudo}`, r, cs.backgroundColor, op, rad),
      );
    }
  }

  async function paintElement(el) {
    if (skipRoot(el) || layers.length >= maxLayers) return;
    const cs = getComputedStyle(el);
    if (!isVisible(cs)) return;
    const r = absRect(el);
    if (r.w < 0.5 || r.h < 0.5) return;
    if (r.y > height + 200 || r.x > width + 200) return;

    const section = el.closest('section[id], section[aria-label], main, header, footer, nav, article');
    const group = section && section !== el ? layerId(section) : 'Page';

    await paintPseudo(el, '::before', group);

    const onlyChild = el.children.length === 1 ? el.children[0] : null;
    const childCs = onlyChild ? getComputedStyle(onlyChild) : null;
    const childR = onlyChild ? absRect(onlyChild) : null;
    const isRedundantWrapper = onlyChild
      && childCs && isVisible(childCs)
      && childR
      && Math.abs(childR.x - r.x) < 2
      && Math.abs(childR.y - r.y) < 2
      && Math.abs(childR.w - r.w) < 2
      && Math.abs(childR.h - r.h) < 2
      && parseAlpha(cs.backgroundColor) <= 0.04
      && !bgImageUrl(cs.backgroundImage)
      && !hasGradient(cs.backgroundImage);

    if (!isRedundantWrapper) {
      await paintBackground(el, cs, r, group);
      paintBorder(el, cs, r, group);
    } else {
      paintBorder(el, cs, r, group);
    }

    const tag = el.tagName;
    if (tag === 'IMG' || tag === 'VIDEO') {
      let src = tag === 'VIDEO' ? (el.getAttribute('poster') || '') : (el.currentSrc || el.getAttribute('src') || '');
      if (src) {
        const href = await inlineImage(src);
        const op = parseFloat(cs.opacity || '1');
        if (href) {
          const opacity = op < 0.999 ? ` opacity="${num(op)}"` : '';
          const fit = cs.objectFit || 'fill';
          const par = fit === 'contain' ? 'xMidYMid meet' : fit === 'cover' ? 'xMidYMid slice' : 'none';
          pushLayer(
            group,
            layerId(el),
            `<image id="${svgEsc(layerId(el))}" x="${r.x}" y="${r.y}" width="${r.w}" height="${r.h}" href="${svgEsc(href)}" xlink:href="${svgEsc(href)}" preserveAspectRatio="${par}"${opacity}/>`,
            'image',
            {
              type: 'IMAGE',
              name: layerId(el),
              x: r.x,
              y: r.y,
              w: r.w,
              h: r.h,
              src: href,
              opacity: op,
              objectFit: fit === 'contain' ? 'contain' : fit === 'cover' ? 'cover' : 'fill',
            },
          );
        } else {
          // Keep layout even when the bitmap is too large to embed.
          const fill = parseAlpha(cs.backgroundColor) > 0.04 ? cs.backgroundColor : '#c4c4c4';
          const rad = radii(cs);
          pushLayer(
            group,
            layerId(el),
            rectAttrs(r, cs, layerId(el), svgEsc(fill)),
            'image',
            rectScene(layerId(el), r, fill, op, rad),
          );
        }
      }
    } else if (tag === 'SVG' && r.w > 2 && r.h > 2) {
      try {
        const clone = el.cloneNode(true);
        clone.setAttribute('x', String(r.x));
        clone.setAttribute('y', String(r.y));
        clone.setAttribute('width', String(r.w));
        clone.setAttribute('height', String(r.h));
        pushLayer(group, layerId(el), clone.outerHTML, 'svg', null);
      } catch {}
    }

    await paintPseudo(el, '::after', group);
  }

  async function paintTextNodes() {
    const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node?.nodeValue || !String(node.nodeValue).trim()) return NodeFilter.FILTER_REJECT;
        const p = node.parentElement;
        if (!p || skipRoot(p)) return NodeFilter.FILTER_REJECT;
        return NodeFilter.FILTER_ACCEPT;
      },
    });

    while (walker.nextNode() && layers.length < maxLayers) {
      const node = walker.currentNode;
      const parent = node.parentElement;
      const cs = getComputedStyle(parent);
      if (!isVisible(cs)) continue;

      const range = document.createRange();
      range.selectNodeContents(node);
      const rects = [...range.getClientRects()].filter((rc) => rc.width >= 0.5 && rc.height >= 0.5);
      if (!rects.length) continue;

      const raw = String(node.nodeValue).replace(/\s+/g, ' ').trim();
      if (!raw || raw.length > 2000) continue;
      const display = applyTextTransform(raw, cs.textTransform);
      const lines = splitTextLines(display, rects, cs);
      const fontSize = parseFloat(cs.fontSize) || 16;
      const fontFamily = (cs.fontFamily || 'Inter').split(',')[0].replace(/['"]/g, '').trim() || 'Inter';
      const section = parent.closest('section[id], section[aria-label], main, header, footer, nav, article');
      const group = section ? layerId(section) : 'Page';

      for (const line of lines) {
        if (!line.text) continue;
        const rc = line.rect;
        const x = num(rc.left + window.scrollX);
        const y = num(rc.top + window.scrollY);
        const key = `${line.text}@@${Math.round(x)}@@${Math.round(y)}`;
        if (seenText.has(key)) continue;
        seenText.add(key);

        const baseline = num(y + fontSize * 0.82);
        const op = parseFloat(cs.opacity || '1');
        const opacity = op < 0.999 ? ` opacity="${num(op)}"` : '';
        const fontStyle = /italic/i.test(cs.fontStyle || '') ? 'italic' : 'normal';
        const id = `text-${layers.length}`;
        pushLayer(
          group,
          id,
          `<text id="${id}" x="${x}" y="${baseline}" fill="${svgEsc(cs.color || '#000')}" font-family="${svgEsc(fontFamily)}" font-size="${num(fontSize)}" font-weight="${svgEsc(String(cs.fontWeight || '400'))}" font-style="${fontStyle}" letter-spacing="${svgEsc(cs.letterSpacing || 'normal')}" xml:space="preserve"${opacity}>${svgEsc(line.text)}</text>`,
          'text',
          {
            type: 'TEXT',
            name: id,
            x,
            y,
            w: num(Math.max(8, rc.width || line.text.length * fontSize * 0.55)),
            h: num(Math.max(fontSize * 1.2, rc.height || fontSize)),
            characters: line.text,
            fill: cs.color || '#000000',
            fontFamily,
            fontSize: num(fontSize),
            fontWeight: String(cs.fontWeight || '400'),
            fontStyle,
            letterSpacing: cs.letterSpacing && cs.letterSpacing !== 'normal' ? num(parseFloat(cs.letterSpacing) || 0) : 0,
            lineHeight: parseLineHeightPx(cs, fontSize),
            textAlign: mapTextAlign(cs),
            textDecoration: mapTextDecoration(cs),
            opacity: op,
          },
        );
      }
    }
  }

  forceRevealForExport();

  const allEls = [...document.body.querySelectorAll('*')];

  for (const rootEl of [document.documentElement, document.body]) {
    const cs = getComputedStyle(rootEl);
    if (!isVisible(cs)) continue;
    const r = { x: 0, y: 0, w: width, h: height };
    await paintBackground(rootEl, cs, r, 'Page');
  }

  for (const el of allEls) {
    if (layers.length >= maxLayers) break;
    await paintElement(el);
  }
  await paintTextNodes();

  const bodyBg = getComputedStyle(document.body).backgroundColor;
  const pageBg = parseAlpha(bodyBg) > 0.04 ? bodyBg : (parseAlpha(getComputedStyle(document.documentElement).backgroundColor) > 0.04
    ? getComputedStyle(document.documentElement).backgroundColor
    : '#ffffff');

  if (format === 'scene') {
    const byGroup = new Map();
    for (const layer of layers) {
      if (!layer.sceneNode) continue;
      if (!byGroup.has(layer.group)) byGroup.set(layer.group, []);
      byGroup.get(layer.group).push(layer.sceneNode);
    }
    const nodes = [];
    for (const [name, children] of byGroup) {
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
      nodes.push({
        type: 'FRAME',
        name,
        x: num(minX),
        y: num(minY),
        w: num(Math.max(1, maxX - minX)),
        h: num(Math.max(1, maxY - minY)),
        children,
      });
    }
    const scene = {
      kind: 'clonyfy-figma-scene',
      version: 1,
      name: String(options.name || options.route || document.title || 'Clonyfy page'),
      route: options.route || undefined,
      page: { width, height, fill: pageBg },
      nodes,
    };
    if (!nodes.length) {
      throw new Error('No exportable layers found on this page (empty scene). Check that the clone HTML has visible content.');
    }
    return scene;
  }

  const groups = new Map();
  groups.set('Page', []);
  for (const layer of layers) {
    if (!groups.has(layer.group)) groups.set(layer.group, []);
    groups.get(layer.group).push(layer);
  }

  const parts = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}">`,
    `<title>${svgEsc(document.title || 'Clonyfy export')}</title>`,
    '<desc>Clonyfy scene graph — vector layers from computed styles (no screenshots)</desc>',
  ];

  if (defs.length) parts.push(`<defs>${defs.join('')}</defs>`);
  parts.push(`<rect id="page-background" x="0" y="0" width="${width}" height="${height}" fill="${svgEsc(pageBg)}"/>`);
  for (const [name, items] of groups) {
    if (!items.length) continue;
    parts.push(`<g id="${svgEsc(name)}" data-clonyfy-section="true">`);
    for (const item of items) if (item.svg) parts.push(item.svg);
    parts.push('</g>');
  }
  parts.push('</svg>');
  return parts.join('\n');
}
