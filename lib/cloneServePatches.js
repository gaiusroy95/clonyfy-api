/**
 * Canonical HTML patches for Run Preview and Export Code.
 * Save As–level: keep text + images visible; never re-hide content.
 */
import { carouselFixInlineScript, CAROUSEL_SKIP_SELECTOR } from './carousel-fix.js';

/**
 * Bake Save As visibility into HTML (works without site JS).
 * Strips common hide-until-JS utility classes and forces text/media visible.
 */
export function bakeStaticMediaVisibilityHtml(html) {
  let out = String(html || '');
  if (!out || /id=["']clonyfy-static-media-bake["']/.test(out)) return out;
  out = out.replace(/\sloading=(["'])lazy\1/gi, ' loading="eager"');
  out = out.replace(
    /\bclass=(["'])([^"']*)\1/gi,
    (_m, q, cls) => {
      const next = String(cls)
        .replace(/\bopacity-0\b/g, '')
        .replace(/\binvisible\b/g, '')
        .replace(/\btranslate-y-(?:\d+|full)\b/g, '')
        .replace(/\bdelay-\d+\b/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      return `class=${q}${next}${q}`;
    },
  );
  const bakeCss = `<style id="clonyfy-static-media-bake">html,body,#__next,#root{opacity:1!important;visibility:visible!important}html.js,html.no-js,body.preload,body.loading,body.no-js{opacity:1!important;visibility:visible!important}.opacity-0,[class*="opacity-0"]:not([aria-hidden="true"]){opacity:1!important;visibility:visible!important}.invisible:not([aria-hidden="true"]){visibility:visible!important}[style*="opacity:0"]:not([aria-hidden="true"]),[style*="opacity: 0"]:not([aria-hidden="true"]){opacity:1!important;visibility:visible!important}[style*="visibility:hidden"]:not([aria-hidden="true"]),[style*="visibility: hidden"]:not([aria-hidden="true"]){visibility:visible!important}[data-aos]:not([aria-hidden="true"]),[data-framer-appear-id]:not([aria-hidden="true"]){opacity:1!important;visibility:visible!important;transform:none!important}img,picture,video,source{opacity:1!important;visibility:visible!important}img[hidden],picture[hidden],video[hidden]{display:revert!important}</style>`;
  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (m) => `${m}${bakeCss}`);
  else if (/<html[^>]*>/i.test(out)) out = out.replace(/<html[^>]*>/i, (m) => `${m}<head>${bakeCss}</head>`);
  else out = bakeCss + out;
  return out;
}

export function buildVisibilityPatchHtml(baseHref = '/', { includeBase = true } = {}) {
  const base = String(baseHref || '/').endsWith('/') ? baseHref : `${baseHref}/`;
  const CS = CAROUSEL_SKIP_SELECTOR.replace(/'/g, "\\'");
  const baseTag = includeBase ? `<base href="${base}">` : '';
  // Save As: reveal text + media. Skip only aria-hidden inactive carousel layers.
  return `${baseTag}<style id="__clonyfy_visibility_fix__">html,body,#__next,#root{opacity:1!important;visibility:visible!important}html.js,html.no-js,body.preload,body.loading,body.no-js{opacity:1!important;visibility:visible!important}.opacity-0,[class*="opacity-0"]:not([aria-hidden="true"]){opacity:1!important;visibility:visible!important}[data-aos]:not([aria-hidden="true"]),[style*="opacity:0"]:not([aria-hidden="true"]),[style*="opacity: 0"]:not([aria-hidden="true"]){opacity:1!important;visibility:visible!important}[data-aos]{transform:none!important}img,picture,video,source{opacity:1!important;visibility:visible!important}</style><script id="__clonyfy_visibility_script__">(function(){var CS='${CS}';function shouldResetTransform(t){if(!t||t==='none')return false;if(/translateY\\([^)]*-?\\d{2,}/.test(t))return true;if(/translate3d\\([^)]*,\\s*-?\\d{2,}/.test(t))return true;return false;}function isInactiveLayer(el){try{if(el.getAttribute&&el.getAttribute('aria-hidden')==='true')return true;if(el.closest&&el.closest('[aria-hidden="true"]'))return true;}catch(e){}return false;}function hasLiveMotion(el){try{var cs=window.getComputedStyle(el);var name=String(cs.animationName||'');if(name&&name!=='none'){var play=String(cs.animationPlayState||'');if(play!=='paused')return true;}var cls=String(el.className||'');if(/\\b(marquee|ticker|ken-burns|kenburns)\\b/i.test(cls))return true;if(el.closest&&el.closest('.marquee-inner,[class*="marquee"],[class*="ticker"]'))return true;}catch(e){}return false;}function revealLazyMedia(){try{document.querySelectorAll('img[loading="lazy"],source[loading="lazy"]').forEach(function(img){try{img.loading='eager';if(img.dataset&&img.dataset.src&&!img.getAttribute('src'))img.src=img.dataset.src;}catch(e){}});document.querySelectorAll('img,picture,video').forEach(function(el){try{if(isInactiveLayer(el))return;var cs=window.getComputedStyle(el);if(cs.opacity==='0'||parseFloat(cs.opacity)<0.05)el.style.setProperty('opacity','1','important');if(cs.visibility==='hidden')el.style.setProperty('visibility','visible','important');var p=el.parentElement;for(var i=0;p&&i<6;i++,p=p.parentElement){if(p.closest&&p.closest(CS))break;if(isInactiveLayer(p))break;var pcs=window.getComputedStyle(p);if(pcs.opacity==='0'||parseFloat(pcs.opacity)<0.05)p.style.setProperty('opacity','1','important');if(pcs.visibility==='hidden')p.style.setProperty('visibility','visible','important');}}catch(e){}});}catch(e){}}function reveal(){try{revealLazyMedia();document.querySelectorAll('[style*="opacity:0"],[style*="opacity: 0"],.opacity-0,[class*="opacity-0"],.invisible,[data-aos],[data-framer-appear-id]').forEach(function(el){if(el.classList&&el.classList.contains('clonyfy-reveal'))return;if(isInactiveLayer(el))return;if(el.closest&&el.closest(CS))return;var r=el.getBoundingClientRect();if(r.width<2||r.height<2)return;if(el.classList){el.classList.remove('opacity-0','invisible');for(var i=el.classList.length-1;i>=0;i--){var c=el.classList[i];if(/^translate-y-(?:\\d+|full)$/.test(c)||/^delay-\\d+$/.test(c))el.classList.remove(c);}}el.style.setProperty('opacity','1','important');el.style.setProperty('visibility','visible','important');if(el.hasAttribute&&el.hasAttribute('data-aos')){el.classList.add('aos-animate');el.style.setProperty('transform','none','important');}});document.querySelectorAll('[style*="visibility:hidden"],[style*="visibility: hidden"]').forEach(function(el){if(isInactiveLayer(el))return;if(el.closest&&el.closest(CS))return;var r=el.getBoundingClientRect();if(r.width>=2&&r.height>=2)el.style.visibility='visible';});document.querySelectorAll('video').forEach(function(v){try{v.setAttribute('playsinline','');v.setAttribute('muted','');v.muted=true;if(v.getAttribute('autoplay')!==null){var p=v.play();if(p&&p.catch)p.catch(function(){});}}catch(e){}});document.querySelectorAll('[style*="transform"]').forEach(function(el){if(el.classList&&el.classList.contains('clonyfy-reveal'))return;if(el.closest&&el.closest(CS))return;if(isInactiveLayer(el))return;if(hasLiveMotion(el))return;var t=el.style.transform;if(shouldResetTransform(t))el.style.transform='none';});}catch(e){}}try{var h=document.documentElement;['loading','no-js','is-loading','preload'].forEach(function(c){h.classList.remove(c)});h.classList.add('js','clonyfy-preview');reveal();document.addEventListener('DOMContentLoaded',reveal);setTimeout(reveal,400);setTimeout(reveal,1200);setTimeout(reveal,2800);${carouselFixInlineScript()}}catch(e){}})();</script>`;
}

/** Disabled for Save As–level clones — re-hiding text with opacity:0 fights the goal. Opt-in via CLONYFY_SCROLL_REVEAL=1. */
export function buildScrollAnimationsPatchHtml() {
  return '';
}
