/** Shared carousel/slider + stacked text-rotator normalization for capture + preview. */

export const CAROUSEL_SKIP_SELECTOR = [
  '[class*="slideshow"]',
  '[class*="carousel"]',
  '[class*="slider"]',
  '[data-slider]',
  '[data-carousel]',
  '[role="region"][aria-roledescription*="carousel" i]',
  '[class*="rotat"]',
  '[class*="word-cycle"]',
  '[class*="text-cycle"]',
  '[class*="text-rotat"]',
  '[class*="headline-rotat"]',
  '[class*="animated-text"]',
  '[data-text-rotat]',
  '[data-rotator]',
  '[data-animate-text]',
  '.clonyfy-stacked-rotator',
].join(',');

export const CAROUSEL_CONTAINER_SELECTOR = CAROUSEL_SKIP_SELECTOR;

export const CAROUSEL_SLIDE_SELECTOR = [
  '[class*="slide"]',
  '[data-slide]',
  '[role="group"]',
  'li[class*="slide"]',
].join(',');

/** Browser-side: hide inactive slides / stacked text rotators so hero phrases do not overlap. */
export function normalizeCarouselsInDocument() {
  normalizeAllMotionStacksInDocument();
}

export function normalizeAllMotionStacksInDocument() {
  const containerSel = CAROUSEL_CONTAINER_SELECTOR;
  const slideSel = CAROUSEL_SLIDE_SELECTOR;
  document.querySelectorAll(containerSel).forEach((container) => {
    const slides = container.querySelectorAll(slideSel);
    if (slides.length < 2) return;

    let active = container.querySelector(
      '.is-active,.active,.current,[aria-current="true"],[aria-hidden="false"],[data-active="true"],[data-state="active"]',
    );
    if (!active || !container.contains(active)) {
      let best = slides[0];
      let bestScore = -1;
      slides.forEach((slide) => {
        const cs = window.getComputedStyle(slide);
        const z = parseInt(cs.zIndex, 10) || 0;
        const op = parseFloat(cs.opacity) || 0;
        const score = z * 100 + op;
        if (score > bestScore) {
          bestScore = score;
          best = slide;
        }
      });
      active = best;
    }

    slides.forEach((slide) => {
      const el = slide;
      const isActive = slide === active || slide.contains(active) || active?.contains(slide);
      if (isActive) {
        el.style.opacity = '1';
        el.style.visibility = 'visible';
        el.style.pointerEvents = '';
        el.removeAttribute('aria-hidden');
      } else {
        el.style.opacity = '0';
        el.style.visibility = 'hidden';
        el.style.pointerEvents = 'none';
        el.style.transform = 'none';
        el.setAttribute('aria-hidden', 'true');
      }
    });
  });

  normalizeStackedTextRotatorsInDocument();
}

function rectsOverlapHeavily(a, b) {
  const ix = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left));
  const iy = Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top));
  const inter = ix * iy;
  if (inter <= 0) return false;
  const areaA = Math.max(1, a.width * a.height);
  const areaB = Math.max(1, b.width * b.height);
  return inter / Math.min(areaA, areaB) >= 0.45;
}

function looksLikeTextLayer(el) {
  const text = (el.textContent || '').replace(/\s+/g, ' ').trim();
  if (text.length < 2 || text.length > 180) return false;
  const tag = el.tagName;
  if (/^(SCRIPT|STYLE|LINK|META|SVG|PATH|IMG|VIDEO|SOURCE|IFRAME|CANVAS)$/i.test(tag)) return false;
  return true;
}

function layerScore(el) {
  const cs = window.getComputedStyle(el);
  const z = parseInt(cs.zIndex, 10) || 0;
  const op = parseFloat(cs.opacity) || 0;
  const ariaHidden = el.getAttribute('aria-hidden') === 'true' ? -50 : 0;
  const activeClass = /\b(is-active|active|current|visible|show|in)\b/i.test(el.className || '') ? 40 : 0;
  return z * 100 + op * 20 + ariaHidden + activeClass;
}

function hideInactiveLayer(el, active) {
  if (active) {
    el.style.opacity = '1';
    el.style.visibility = 'visible';
    el.style.pointerEvents = '';
    el.removeAttribute('aria-hidden');
    el.removeAttribute('hidden');
  } else {
    el.style.opacity = '0';
    el.style.visibility = 'hidden';
    el.style.pointerEvents = 'none';
    el.style.transform = 'none';
    el.setAttribute('aria-hidden', 'true');
  }
}

function collapseStack(layers, seen) {
  let active = layers.find((el) =>
    el.getAttribute('aria-hidden') === 'false'
    || /\b(is-active|active|current|visible|show|in)\b/i.test(el.className || ''),
  ) || null;
  if (!active) {
    active = layers.reduce((best, el) => (layerScore(el) > layerScore(best) ? el : best), layers[0]);
  }
  const parent = layers[0] && layers[0].parentElement;
  if (parent) {
    parent.classList.add('clonyfy-stacked-rotator');
    const pcs = window.getComputedStyle(parent);
    if (pcs.position === 'static') parent.style.position = 'relative';
  }
  layers.forEach((el) => {
    seen.add(el);
    hideInactiveLayer(el, el === active);
  });
}

export function normalizeStackedTextRotatorsInDocument() {
  const seen = new Set();

  // Prefer accessible static headline over animated absolute phrase stacks (Shopify hero).
  document.querySelectorAll('[aria-hidden="true"]').forEach((animated) => {
    const absCount = animated.querySelectorAll('[class*="absolute"],.absolute').length;
    const fadedCount = animated.querySelectorAll('[class*="opacity-0"],.opacity-0').length;
    if (absCount < 1 && fadedCount < 2) return;
    const prev = animated.previousElementSibling;
    if (!prev) return;
    const prevClass = String(prev.className || '');
    const hasFallbackHeading = !!(prev.querySelector('h1,h2,h3') || /^H[1-3]$/.test(prev.tagName));
    const looksSrOnly = /\bsr-only\b|visually-hidden|js-disabled:not-sr-only/i.test(prevClass);
    if (!hasFallbackHeading && !looksSrOnly) return;
    animated.style.setProperty('display', 'none', 'important');
    seen.add(animated);
    prev.classList.remove('sr-only');
    prev.style.setProperty('position', 'static', 'important');
    prev.style.setProperty('width', 'auto', 'important');
    prev.style.setProperty('height', 'auto', 'important');
    prev.style.setProperty('overflow', 'visible', 'important');
    prev.style.setProperty('clip', 'auto', 'important');
    prev.style.setProperty('clip-path', 'none', 'important');
    prev.style.setProperty('white-space', 'normal', 'important');
    prev.style.setProperty('margin', '0', 'important');
    prev.style.setProperty('padding', '0', 'important');
    prev.removeAttribute('aria-hidden');
    seen.add(prev);
  });

  document.querySelectorAll('.relative, [class*="relative"]').forEach((rel) => {
    if (seen.has(rel)) return;
    const phraseRoots = Array.from(rel.children).filter((child) => {
      if (!child.querySelector) return false;
      if (!child.querySelector('[class*="absolute"],.absolute')) return false;
      const text = (child.textContent || '').replace(/\s+/g, ' ').trim();
      return text.length >= 2 && text.length <= 180;
    });
    if (phraseRoots.length < 2) return;
    let active = phraseRoots.find((el) => {
      const live = el.querySelector('[class*="opacity-100"],.opacity-100');
      const dead = el.querySelector('[class*="opacity-0"],.opacity-0,[class*="translate-y-100"]');
      return !!live && !dead;
    }) || phraseRoots.reduce((best, el) => (layerScore(el) > layerScore(best) ? el : best), phraseRoots[0]);
    rel.classList.add('clonyfy-stacked-rotator');
    phraseRoots.forEach((el) => {
      seen.add(el);
      hideInactiveLayer(el, el === active);
      el.querySelectorAll('span').forEach((span) => hideInactiveLayer(span, el === active));
    });
  });

  const parents = document.querySelectorAll('h1,h2,h3,[class*="hero"],[class*="Hero"],[class*="headline"],[class*="Headline"],[class*="banner"],[data-hero],section,header,main');

  parents.forEach((parent) => {
    const children = Array.from(parent.children).filter((el) => {
      if (seen.has(el)) return false;
      if (!looksLikeTextLayer(el)) return false;
      const cs = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      if (rect.width < 40 || rect.height < 16) return false;
      const positioned = cs.position === 'absolute' || cs.position === 'fixed' || cs.position === 'sticky';
      const transformed = cs.transform && cs.transform !== 'none';
      const aria = el.hasAttribute('aria-hidden');
      return positioned || transformed || aria || parseFloat(cs.opacity) < 0.95;
    });

    if (children.length < 2) {
      Array.from(parent.children).forEach((wrap) => {
        if (seen.has(wrap)) return;
        const nested = Array.from(wrap.children).filter((el) => looksLikeTextLayer(el));
        if (nested.length < 2) return;
        const rects = nested.map((el) => el.getBoundingClientRect());
        let overlapPairs = 0;
        for (let i = 0; i < nested.length; i++) {
          for (let j = i + 1; j < nested.length; j++) {
            if (rectsOverlapHeavily(rects[i], rects[j])) overlapPairs++;
          }
        }
        if (overlapPairs < 1) return;
        collapseStack(nested, seen);
      });
      return;
    }

    const rects = children.map((el) => el.getBoundingClientRect());
    let overlapPairs = 0;
    for (let i = 0; i < children.length; i++) {
      for (let j = i + 1; j < children.length; j++) {
        if (rectsOverlapHeavily(rects[i], rects[j])) overlapPairs++;
      }
    }
    if (overlapPairs < 1) return;
    collapseStack(children, seen);
  });

  document.querySelectorAll('div,span,p,li').forEach((parent) => {
    if (seen.has(parent)) return;
    const kids = Array.from(parent.children).filter((el) => looksLikeTextLayer(el));
    if (kids.length < 2 || kids.length > 12) return;
    const rects = kids.map((el) => el.getBoundingClientRect());
    let heavy = 0;
    for (let i = 0; i < kids.length; i++) {
      for (let j = i + 1; j < kids.length; j++) {
        if (rectsOverlapHeavily(rects[i], rects[j])) heavy++;
      }
    }
    const maxPairs = (kids.length * (kids.length - 1)) / 2;
    if (heavy < Math.max(1, Math.floor(maxPairs * 0.4))) return;
    collapseStack(kids, seen);
  });
}

export function isInsideCarousel(el) {
  return !!(el && el.closest && el.closest(CAROUSEL_SKIP_SELECTOR));
}

/** Minified script injected into preview HTML (no module loader). */
export function carouselFixInlineScript() {
  // Keep this as one IIFE string — runs in preview + share pages after DOM load.
  return `(function(){function overlap(a,b){var ix=Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left));var iy=Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));var inter=ix*iy;if(inter<=0)return false;var aa=Math.max(1,a.width*a.height),bb=Math.max(1,b.width*b.height);return inter/Math.min(aa,bb)>=0.45;}function textLayer(el){var t=(el.textContent||'').replace(/\\s+/g,' ').trim();if(t.length<2||t.length>180)return false;if(/^(SCRIPT|STYLE|LINK|META|SVG|PATH|IMG|VIDEO|SOURCE|IFRAME|CANVAS)$/i.test(el.tagName))return false;return true;}function score(el){var cs=getComputedStyle(el),z=parseInt(cs.zIndex,10)||0,op=parseFloat(cs.opacity)||0,ah=el.getAttribute('aria-hidden')==='true'?-50:0,ac=/\\b(is-active|active|current|visible|show|in)\\b/i.test(el.className||'')?40:0;return z*100+op*20+ah+ac;}function hide(el,on){if(on){el.style.opacity='1';el.style.visibility='visible';el.style.pointerEvents='';el.removeAttribute('aria-hidden');el.removeAttribute('hidden');}else{el.style.opacity='0';el.style.visibility='hidden';el.style.pointerEvents='none';el.style.transform='none';el.setAttribute('aria-hidden','true');}}function collapse(layers,seen){var active=null;for(var i=0;i<layers.length;i++){var el=layers[i];if(el.getAttribute('aria-hidden')==='false'||/\\b(is-active|active|current|visible|show|in)\\b/i.test(el.className||'')){active=el;break;}}if(!active){active=layers[0];for(var j=1;j<layers.length;j++){if(score(layers[j])>score(active))active=layers[j];}}var parent=layers[0]&&layers[0].parentElement;if(parent){parent.classList.add('clonyfy-stacked-rotator');if(getComputedStyle(parent).position==='static')parent.style.position='relative';}layers.forEach(function(el){seen.add(el);hide(el,el===active);});}function normCarousels(){var CS='${CAROUSEL_CONTAINER_SELECTOR.replace(/'/g, "\\'")}',SS='${CAROUSEL_SLIDE_SELECTOR.replace(/'/g, "\\'")}';document.querySelectorAll(CS).forEach(function(c){var slides=c.querySelectorAll(SS);if(slides.length<2)return;var active=c.querySelector('.is-active,.active,.current,[aria-current="true"],[aria-hidden="false"],[data-active="true"],[data-state="active"]');if(!active||!c.contains(active)){var best=slides[0],bestScore=-1;slides.forEach(function(s){var cs=getComputedStyle(s),z=parseInt(cs.zIndex,10)||0,op=parseFloat(cs.opacity)||0,sc=z*100+op;if(sc>bestScore){bestScore=sc;best=s;}});active=best;}slides.forEach(function(slide){var isA=slide===active||slide.contains(active)||(active&&active.contains(slide));hide(slide,!!isA);});});}function normStacks(){document.querySelectorAll('[aria-hidden="true"]').forEach(function(animated){var absCount=animated.querySelectorAll('[class*="absolute"],.absolute').length;var fadedCount=animated.querySelectorAll('[class*="opacity-0"],.opacity-0').length;if(absCount<1&&fadedCount<2)return;var prev=animated.previousElementSibling;if(!prev)return;var prevClass=String(prev.className||'');var hasHeading=!!(prev.querySelector('h1,h2,h3')||/^H[1-3]$/.test(prev.tagName));var sr=/\\bsr-only\\b|visually-hidden|js-disabled:not-sr-only/i.test(prevClass);if(!hasHeading&&!sr)return;animated.style.setProperty('display','none','important');prev.classList.remove('sr-only');prev.style.setProperty('position','static','important');prev.style.setProperty('width','auto','important');prev.style.setProperty('height','auto','important');prev.style.setProperty('overflow','visible','important');prev.style.setProperty('clip','auto','important');prev.style.setProperty('clip-path','none','important');prev.style.setProperty('white-space','normal','important');prev.style.setProperty('margin','0','important');prev.style.setProperty('padding','0','important');prev.removeAttribute('aria-hidden');});var seen=new Set();document.querySelectorAll('.relative,[class*="relative"]').forEach(function(rel){var phraseRoots=Array.prototype.filter.call(rel.children,function(child){return child.querySelector&&child.querySelector('[class*="absolute"],.absolute')&&textLayer(child);});if(phraseRoots.length<2)return;var active=phraseRoots.find(function(el){return el.querySelector('[class*="opacity-100"],.opacity-100')&&!el.querySelector('[class*="opacity-0"],.opacity-0');})||phraseRoots[0];rel.classList.add('clonyfy-stacked-rotator');phraseRoots.forEach(function(el){seen.add(el);hide(el,el===active);el.querySelectorAll('span').forEach(function(span){hide(span,el===active);});});});document.querySelectorAll('h1,h2,h3,[class*="hero"],[class*="Hero"],[class*="headline"],[class*="Headline"],[class*="banner"],[data-hero],section,header,main').forEach(function(parent){var children=Array.prototype.filter.call(parent.children,function(el){if(seen.has(el)||!textLayer(el))return false;var cs=getComputedStyle(el),r=el.getBoundingClientRect();if(r.width<40||r.height<16)return false;var pos=cs.position==='absolute'||cs.position==='fixed'||cs.position==='sticky';var tr=cs.transform&&cs.transform!=='none';return pos||tr||el.hasAttribute('aria-hidden')||parseFloat(cs.opacity)<0.95;});if(children.length<2){Array.prototype.forEach.call(parent.children,function(wrap){if(seen.has(wrap))return;var nested=Array.prototype.filter.call(wrap.children,textLayer);if(nested.length<2)return;var rects=nested.map(function(el){return el.getBoundingClientRect();});var pairs=0;for(var i=0;i<nested.length;i++){for(var j=i+1;j<nested.length;j++){if(overlap(rects[i],rects[j]))pairs++;}}if(pairs>=1)collapse(nested,seen);});return;}var rects=children.map(function(el){return el.getBoundingClientRect();});var pairs=0;for(var i=0;i<children.length;i++){for(var j=i+1;j<children.length;j++){if(overlap(rects[i],rects[j]))pairs++;}}if(pairs>=1)collapse(children,seen);});document.querySelectorAll('div,span,p,li').forEach(function(parent){if(seen.has(parent))return;var kids=Array.prototype.filter.call(parent.children,textLayer);if(kids.length<2||kids.length>12)return;var rects=kids.map(function(el){return el.getBoundingClientRect();});var heavy=0;for(var i=0;i<kids.length;i++){for(var j=i+1;j<kids.length;j++){if(overlap(rects[i],rects[j]))heavy++;}}var maxPairs=(kids.length*(kids.length-1))/2;if(heavy<Math.max(1,Math.floor(maxPairs*0.4)))return;collapse(kids,seen);});}function run(){try{normCarousels();normStacks();}catch(e){}}run();if(document.readyState==='loading')document.addEventListener('DOMContentLoaded',run,{once:true});setTimeout(run,400);setTimeout(run,1200);})();`;
}
