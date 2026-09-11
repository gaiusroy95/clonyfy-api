/**
 * Canonical HTML patches for Run Preview and Export Code.
 * Keep these identical so localhost:3000 matches /api/page.
 */
import { carouselFixInlineScript, CAROUSEL_SKIP_SELECTOR } from './carousel-fix.js';

/**
 * Site-agnostic media bake: eager-load images and force opacity/visibility
 * on media nodes. No brand-specific class names.
 */
export function bakeStaticMediaVisibilityHtml(html) {
  let out = String(html || '');
  if (!out || /id=["']clonyfy-static-media-bake["']/.test(out)) return out;
  out = out.replace(/\sloading=(["'])lazy\1/gi, ' loading="eager"');
  const bakeCss = `<style id="clonyfy-static-media-bake">img,picture,video,source{opacity:1!important;visibility:visible!important}img[hidden],picture[hidden],video[hidden]{display:revert!important}</style>`;
  if (/<head[^>]*>/i.test(out)) out = out.replace(/<head[^>]*>/i, (m) => `${m}${bakeCss}`);
  else if (/<html[^>]*>/i.test(out)) out = out.replace(/<html[^>]*>/i, (m) => `${m}<head>${bakeCss}</head>`);
  else out = bakeCss + out;
  return out;
}

export function buildVisibilityPatchHtml(baseHref = '/', { includeBase = true } = {}) {
  const base = String(baseHref || '/').endsWith('/') ? baseHref : `${baseHref}/`;
  const CS = CAROUSEL_SKIP_SELECTOR.replace(/'/g, "\\'");
  const baseTag = includeBase ? `<base href="${base}">` : '';
  // Intentionally NO display:block!important on body/#__next — that flattens
  // flex/grid heroes. Reveal opacity/visibility-hidden media containers generically.
  return `${baseTag}<style id="__clonyfy_visibility_fix__">html,body,#__next,#root{opacity:1!important;visibility:visible!important}html.js,html.no-js,body.preload,body.loading,body.no-js{opacity:1!important;visibility:visible!important}[data-aos]:not([aria-hidden="true"]),[style*="opacity:0"]:not([aria-hidden="true"]),[style*="opacity: 0"]:not([aria-hidden="true"]){opacity:1!important;visibility:visible!important}[data-aos]{transform:none!important}img,picture,video,source{opacity:1!important;visibility:visible!important}</style><script id="__clonyfy_visibility_script__">(function(){var CS='${CS}';function shouldResetTransform(t){if(!t||t==='none')return false;if(/translateY\\([^)]*-?\\d{2,}/.test(t))return true;if(/translate3d\\([^)]*,\\s*-?\\d{2,}/.test(t))return true;return false;}function overlapsSiblingText(el){var parent=el.parentElement;if(!parent||parent.children.length<2)return false;var a=el.getBoundingClientRect();if(a.width<40||a.height<16)return false;var text=(el.textContent||'').replace(/\\s+/g,' ').trim();if(text.length<2||text.length>180)return false;for(var i=0;i<parent.children.length;i++){var sib=parent.children[i];if(sib===el)continue;var st=(sib.textContent||'').replace(/\\s+/g,' ').trim();if(st.length<2||st.length>180)continue;var b=sib.getBoundingClientRect();var ix=Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left));var iy=Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));var inter=ix*iy;if(inter<=0)continue;var minArea=Math.min(Math.max(1,a.width*a.height),Math.max(1,b.width*b.height));if(inter/minArea>=0.45)return true;}return false;}function hasLiveMotion(el){try{var cs=window.getComputedStyle(el);var name=String(cs.animationName||'');if(name&&name!=='none'){var play=String(cs.animationPlayState||'');if(play!=='paused')return true;}var cls=String(el.className||'');if(/\\b(marquee|ticker|ken-burns|kenburns)\\b/i.test(cls))return true;if(el.closest&&el.closest('.marquee-inner,[class*="marquee"],[class*="ticker"]'))return true;}catch(e){}return false;}function isStackedRotator(el){try{if(el.getAttribute&&el.getAttribute('aria-hidden')==='true')return true;if(el.closest&&el.closest('.clonyfy-stacked-rotator,[aria-hidden="true"]'))return true;if(overlapsSiblingText(el))return true;var cls=String(el.className||'');var text=(el.textContent||'').replace(/\\s+/g,' ').trim();var hasMedia=!!(el.querySelector&&el.querySelector('img,picture,video,source,canvas,svg'));if(/\\bopacity-0\\b/.test(cls)&&!hasMedia&&text.length>0&&text.length<80){var r=el.getBoundingClientRect();if(r.height>0&&r.height<120)return true;}}catch(e){}return false;}function hasMedia(el){try{if(!el)return false;if(/^(IMG|PICTURE|VIDEO|SOURCE|SVG|CANVAS)$/i.test(el.tagName))return true;return !!(el.querySelector&&el.querySelector('img,picture,video,source,canvas,svg'));}catch(e){return false;}}function revealLazyMedia(){try{document.querySelectorAll('img[loading="lazy"],source[loading="lazy"]').forEach(function(img){try{img.loading='eager';if(img.dataset&&img.dataset.src&&!img.getAttribute('src'))img.src=img.dataset.src;}catch(e){}});document.querySelectorAll('img,picture,video').forEach(function(el){try{var cs=window.getComputedStyle(el);if(cs.opacity==='0'||parseFloat(cs.opacity)<0.05)el.style.setProperty('opacity','1','important');if(cs.visibility==='hidden')el.style.setProperty('visibility','visible','important');var p=el.parentElement;for(var i=0;p&&i<4;i++,p=p.parentElement){if(p.closest&&p.closest(CS))break;var pcs=window.getComputedStyle(p);if(pcs.opacity==='0'||parseFloat(pcs.opacity)<0.05)p.style.setProperty('opacity','1','important');if(pcs.visibility==='hidden')p.style.setProperty('visibility','visible','important');}}catch(e){}});}catch(e){}}function reveal(){try{revealLazyMedia();document.querySelectorAll('[style*="opacity:0"],[style*="opacity: 0"],.opacity-0,[class*="opacity-0"],[data-aos],[data-framer-appear-id]').forEach(function(el){if(el.classList&&el.classList.contains('clonyfy-reveal'))return;if(isStackedRotator(el))return;if(el.closest&&el.closest(CS))return;if(hasLiveMotion(el))return;if(!hasMedia(el)&&!(el.classList&&/\\bopacity-0\\b/.test(String(el.className||'')))){var r0=el.getBoundingClientRect();if(r0.width<2||r0.height<2)return;}var r=el.getBoundingClientRect();if(r.width<2||r.height<2)return;if(el.classList){el.classList.remove('opacity-0');for(var i=el.classList.length-1;i>=0;i--){var c=el.classList[i];if(/^translate-y-(?:\\d+|full)$/.test(c)||/^delay-\\d+$/.test(c))el.classList.remove(c);}}el.style.setProperty('opacity','1','important');el.style.setProperty('visibility','visible','important');if(el.hasAttribute&&el.hasAttribute('data-aos')){el.classList.add('aos-animate');el.style.setProperty('transform','none','important');}});document.querySelectorAll('[style*="visibility:hidden"],[style*="visibility: hidden"]').forEach(function(el){if(isStackedRotator(el))return;if(el.closest&&el.closest(CS))return;if(hasLiveMotion(el))return;if(!hasMedia(el))return;var r=el.getBoundingClientRect();if(r.width>=2&&r.height>=2)el.style.visibility='visible';});document.querySelectorAll('video').forEach(function(v){try{v.setAttribute('playsinline','');v.setAttribute('muted','');v.muted=true;if(v.getAttribute('autoplay')!==null){var p=v.play();if(p&&p.catch)p.catch(function(){});}}catch(e){}});document.querySelectorAll('[style*="transform"]').forEach(function(el){if(el.classList&&el.classList.contains('clonyfy-reveal'))return;if(el.closest&&el.closest(CS))return;if(isStackedRotator(el))return;if(hasLiveMotion(el))return;if(!hasMedia(el))return;var t=el.style.transform;if(shouldResetTransform(t))el.style.transform='none';});}catch(e){}}try{var h=document.documentElement;['loading','no-js','is-loading','preload'].forEach(function(c){h.classList.remove(c)});h.classList.add('js','clonyfy-preview');reveal();document.addEventListener('DOMContentLoaded',reveal);setTimeout(reveal,400);setTimeout(reveal,1200);setTimeout(reveal,2800);${carouselFixInlineScript()}}catch(e){}})();</script>`;
}

export function buildScrollAnimationsPatchHtml() {
  // Skip CTAs / interactive blocks so scroll-reveal never hides hero buttons.
  // Also skip media-heavy sections so we don't re-hide brochure cards.
  return `<script data-clonyfy-scroll-reveal>
(() => {
  const css = document.createElement('style');
  css.id = 'clonyfy-scroll-reveal-style';
  css.textContent = '.clonyfy-reveal{opacity:0!important;transform:translate3d(0,32px,0)!important;transition:opacity .9s cubic-bezier(.22,1,.36,1),transform .9s cubic-bezier(.22,1,.36,1);will-change:opacity,transform}.clonyfy-reveal.clonyfy-slide-x{transform:translate3d(-28px,0,0)!important}.clonyfy-reveal.clonyfy-zoom{transform:scale(1.05)!important}.clonyfy-reveal.clonyfy-in{opacity:1!important;transform:none!important}@media(prefers-reduced-motion:reduce){.clonyfy-reveal{opacity:1!important;transform:none!important;transition:none!important}}';
  document.head.appendChild(css);

  const skipRoot = 'nav,header,footer,[role="navigation"],.marquee-inner,[class*="marquee"],[class*="ticker"],[class*="slideshow"],[class*="carousel"],[class*="slider"],[data-slider],[data-carousel],[class*="rotat"],.clonyfy-stacked-rotator,picture,video,img,svg,canvas,a,button,[role="button"],form,[id^="ab-section"],[class*="ab-section"]';
  const contentSelectors = [
    'h1','h2','h3','h4','h5','h6','p','li',
    '[data-framer-name]','[data-aos]','[data-scroll]',
    'article','blockquote',
  ].join(',');

  const pickTargets = () => {
    const out = [];
    const seen = new Set();
    const add = (el, variant) => {
      if (!el || seen.has(el)) return;
      if (el.closest && el.closest(skipRoot)) return;
      if (/^(IMG|PICTURE|VIDEO|SOURCE|SVG|CANVAS|IFRAME|A|BUTTON)$/i.test(el.tagName)) return;
      if (el.querySelector && el.querySelector('a,button,[role="button"],img,picture,video,svg,canvas')) return;
      if (el.classList && el.classList.contains('clonyfy-reveal')) return;
      const r = el.getBoundingClientRect();
      if (r.width < 20 || r.height < 10) return;
      seen.add(el);
      out.push({ el, variant: variant || 'y' });
    };

    document.querySelectorAll('main, section[id], section[aria-label], body > section, body > main > div').forEach((section) => {
      section.querySelectorAll(contentSelectors).forEach((el) => {
        let variant = 'y';
        if (out.length % 4 === 1) variant = 'x';
        add(el, variant);
      });
    });

    document.querySelectorAll('[style*="opacity: 0"],[style*="opacity:0"],[style*="translateY"],[style*="translate3d"]').forEach((el) => {
      add(el, 'y');
    });

    return out.slice(0, 140);
  };

  const targets = pickTargets();
  const io = new IntersectionObserver((entries) => {
    entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      entry.target.classList.add('clonyfy-in');
      io.unobserve(entry.target);
    });
  }, { rootMargin: '0px 0px -8% 0px', threshold: 0.12 });

  targets.forEach(({ el, variant }, i) => {
    el.classList.add('clonyfy-reveal');
    if (variant === 'x') el.classList.add('clonyfy-slide-x');
    if (i % 7 === 0) el.classList.add('clonyfy-zoom');
    io.observe(el);
  });
})();
</script>`;
}
