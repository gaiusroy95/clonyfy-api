/**
 * Canonical HTML patches for Run Preview and Export Code.
 * Keep these identical so localhost:3000 matches /api/page.
 */
import { carouselFixInlineScript, CAROUSEL_SKIP_SELECTOR } from './carousel-fix.js';

export function buildVisibilityPatchHtml(baseHref = '/', { includeBase = true } = {}) {
  const base = String(baseHref || '/').endsWith('/') ? baseHref : `${baseHref}/`;
  const CS = CAROUSEL_SKIP_SELECTOR.replace(/'/g, "\\'");
  const baseTag = includeBase ? `<base href="${base}">` : '';
  // Intentionally NO display:block!important on body/#__next — that flattens
  // flex/grid heroes (solid left panel, missing CTAs vs preview).
  return `${baseTag}<style id="__clonyfy_visibility_fix__">html,body,#__next,#root{opacity:1!important;visibility:visible!important}html.js,html.no-js,body.preload,body.loading,body.no-js{opacity:1!important;visibility:visible!important}</style><script id="__clonyfy_visibility_script__">(function(){var CS='${CS}';function shouldResetTransform(t){if(!t||t==='none')return false;if(/translateY\\([^)]*-?\\d{2,}/.test(t))return true;if(/translate3d\\([^)]*,\\s*-?\\d{2,}/.test(t))return true;return false;}function overlapsSiblingText(el){var parent=el.parentElement;if(!parent||parent.children.length<2)return false;var a=el.getBoundingClientRect();if(a.width<40||a.height<16)return false;var text=(el.textContent||'').replace(/\\s+/g,' ').trim();if(text.length<2||text.length>180)return false;for(var i=0;i<parent.children.length;i++){var sib=parent.children[i];if(sib===el)continue;var st=(sib.textContent||'').replace(/\\s+/g,' ').trim();if(st.length<2||st.length>180)continue;var b=sib.getBoundingClientRect();var ix=Math.max(0,Math.min(a.right,b.right)-Math.max(a.left,b.left));var iy=Math.max(0,Math.min(a.bottom,b.bottom)-Math.max(a.top,b.top));var inter=ix*iy;if(inter<=0)continue;var minArea=Math.min(Math.max(1,a.width*a.height),Math.max(1,b.width*b.height));if(inter/minArea>=0.45)return true;}return false;}function hasLiveMotion(el){try{var cs=window.getComputedStyle(el);var name=String(cs.animationName||'');if(name&&name!=='none')return true;var cls=String(el.className||'');if(/\\b(animate|motion|marquee|ticker|scroll|parallax|ken-burns|kenburns)\\b/i.test(cls))return true;if(el.closest&&el.closest('.marquee-inner,[class*="marquee"],[class*="ticker"],[class*="parallax"],[data-animate],[data-aos]'))return true;}catch(e){}return false;}function reveal(){try{document.querySelectorAll('[style*="opacity:0"],[style*="opacity: 0"]').forEach(function(el){if(el.classList&&el.classList.contains('clonyfy-reveal'))return;if(el.getAttribute&&el.getAttribute('aria-hidden')==='true')return;if(el.closest&&el.closest(CS))return;if(overlapsSiblingText(el))return;if(hasLiveMotion(el))return;var r=el.getBoundingClientRect();if(r.width>=2&&r.height>=2)el.style.opacity='1';});document.querySelectorAll('[style*="visibility:hidden"],[style*="visibility: hidden"]').forEach(function(el){if(el.getAttribute&&el.getAttribute('aria-hidden')==='true')return;if(el.closest&&el.closest(CS))return;if(overlapsSiblingText(el))return;if(hasLiveMotion(el))return;var r=el.getBoundingClientRect();if(r.width>=2&&r.height>=2)el.style.visibility='visible';});document.querySelectorAll('video').forEach(function(v){try{v.setAttribute('playsinline','');v.setAttribute('muted','');v.muted=true;if(v.getAttribute('autoplay')!==null){var p=v.play();if(p&&p.catch)p.catch(function(){});}}catch(e){}});document.querySelectorAll('[style*="transform"]').forEach(function(el){if(el.classList&&el.classList.contains('clonyfy-reveal'))return;if(el.closest&&el.closest(CS))return;if(overlapsSiblingText(el))return;if(hasLiveMotion(el))return;var t=el.style.transform;if(shouldResetTransform(t))el.style.transform='none';});}catch(e){}}try{var h=document.documentElement;['loading','no-js','is-loading','preload'].forEach(function(c){h.classList.remove(c)});h.classList.add('js','clonyfy-preview');reveal();document.addEventListener('DOMContentLoaded',reveal);${carouselFixInlineScript()}}catch(e){}})();</script>`;
}

export function buildScrollAnimationsPatchHtml() {
  // Skip CTAs / interactive blocks so scroll-reveal never hides hero buttons.
  return `<script data-clonyfy-scroll-reveal>
(() => {
  const css = document.createElement('style');
  css.id = 'clonyfy-scroll-reveal-style';
  css.textContent = '.clonyfy-reveal{opacity:0!important;transform:translate3d(0,32px,0)!important;transition:opacity .9s cubic-bezier(.22,1,.36,1),transform .9s cubic-bezier(.22,1,.36,1);will-change:opacity,transform}.clonyfy-reveal.clonyfy-slide-x{transform:translate3d(-28px,0,0)!important}.clonyfy-reveal.clonyfy-zoom{transform:scale(1.05)!important}.clonyfy-reveal.clonyfy-in{opacity:1!important;transform:none!important}@media(prefers-reduced-motion:reduce){.clonyfy-reveal{opacity:1!important;transform:none!important;transition:none!important}}';
  document.head.appendChild(css);

  const skipRoot = 'nav,header,footer,[role="navigation"],.marquee-inner,[class*="marquee"],[class*="ticker"],[class*="slideshow"],[class*="carousel"],[class*="slider"],[data-slider],[data-carousel],[class*="rotat"],.clonyfy-stacked-rotator,picture,video,img,svg,canvas,a,button,[role="button"],form';
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

  const run = () => {
    const targets = pickTargets();
    if (!targets.length) return;
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => {
        if (!e.isIntersecting) return;
        e.target.classList.add('clonyfy-in');
        io.unobserve(e.target);
      });
    }, { threshold: 0.08, rootMargin: '0px 0px -4% 0px' });

    targets.forEach(({ el, variant }, i) => {
      el.classList.add('clonyfy-reveal');
      if (variant === 'x') el.classList.add('clonyfy-slide-x');
      const belowFold = el.getBoundingClientRect().top > window.innerHeight;
      el.style.transitionDelay = belowFold ? Math.min(i * 0.055, 0.45) + 's' : '0s';
      if (belowFold) io.observe(el);
      else el.classList.add('clonyfy-in');
    });
  };

  const boot = () => requestAnimationFrame(() => requestAnimationFrame(run));
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot, { once: true });
  else boot();
})();
</script>`;
}
