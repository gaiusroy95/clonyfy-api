# Clonyfy MVP

**Goal:** Ship a simple, fully functional product as soon as possible — **public launch with paid users**.  
**Approach:** Improve the existing HTML clone → preview → edit → share flow. Do not build Algorithms A/B, IR, React/Tailwind codegen, 99% QA, or a Figma plugin for MVP.

---

## Locked decisions (stakeholder, Aug 2025)

| Area | Decision |
|------|----------|
| **Audience** | Public launch; paid product (not internal demo) |
| **Success bar** | Pass all three benchmark sites (E1, L1, S1) — best effort on S1 if bot protection blocks |
| **Visual quality** | Almost no missing images/fonts; obvious breakage unacceptable |
| **Primary delivery** | Vercel-hosted app + **private share links** for generated/edited sites (already wired) |
| **Editor access** | Free: **2 edits, 2 saves, 2 shares/month**; paid: unlimited edit/save (Starter: 25 shares; Growth/Scale: unlimited) |
| **Auth** | **Require login** to clone (no anonymous cloning for MVP) |
| **Environment** | Vercel is the main target; Supabase already configured |
| **Legal** | Respect `robots.txt` when legally necessary (no blanket `--ignore-robots`) |
| **Failed assets** | Fallback placeholder image (“your pic”) when an image cannot be cloned; fallback system font when premium/licensed fonts cannot be fetched |
| **UI copy** | Keep existing Figma/SVG labels — no rename for MVP |
| **Language** | English only |

---

## What MVP is

A logged-in user can:

1. Paste a URL and clone a site (free: 3/month; paid: more)  
2. Preview the result in the app  
3. Edit text, images, and basic styles; save (free: 2 each/month)  
4. Generate a **private share link** on Vercel (free: 2/month)  

**Paid-only:** ZIP export, GitHub push, Netlify deploy.

Success is measured on three sites, in order:

| Priority | Site |
|----------|------|
| 1 | https://www.echeloninternational.ge |
| 2 | https://www.limova.ai |
| 3 | https://stripe.com/ (best-effort; may be limited by bot protection) |

---

## What “done” means

| Flow | Acceptance |
|------|------------|
| **Auth** | Unauthenticated users cannot start a clone; login required |
| **Clone** | Completes without crash on E1, L1, S1; home page present; main nav pages mostly captured |
| **Assets** | ≥95% of visible images on home render (failed assets replaced with placeholder, not broken icons) |
| **Fonts** | Readable text; premium/unfetchable fonts fall back to bundled system font |
| **Preview** | Home (and key pages) render with images/fonts largely intact |
| **Edit** | Free: up to 2 editor sessions/month; paid: unlimited |
| **Save** | Free: up to 2 saves/month; paid: unlimited |
| **Share** | Free: up to 2 links/month; Starter: 25; Growth/Scale: unlimited |

Not required: pixel-perfect match, mobile-native re-crawl, reconstructed animations, React components, or Figma layers.

---

## What we keep (already built)

- Playwright HTML snapshot pipeline (`packages/cloner`)  
- `route-map.json` + `captured-pages/` + `public/_assets/`  
- Web app + editor (`server.js`, `public/app.html`)  
- Vercel deploy + share links + auth / billing as they exist  
- ZIP / Netlify as secondary export paths (fix only if blocking)  

---

## What we improve (only if it helps the three sites)

1. **Capture quality** — fewer missing images/backgrounds/fonts; better lazy-load/scroll  
2. **Asset fallbacks** — placeholder image + fallback font when fetch fails or font is premium  
3. **Desktop fidelity** — fix obvious visual breakage on E1 → L1 → S1  
4. **Editor reliability** — load/save must not break pages (paid users)  
5. **Share path** — private link works end-to-end on Vercel for a real clone  
6. **Auth gate** — require login before clone (remove anonymous clone path)  

---

## Out of scope for MVP

- Shared IR package / scene graph  
- Computed-style extraction platform  
- React + Tailwind code generation  
- Motion reconstruction (GSAP, Framer, Lottie, scroll timelines)  
- Automated 99% screenshot QA / repair loops  
- Multi-breakpoint native capture as a product feature  
- Font licensing substitution engine  
- Native Figma plugin  
- Auth-wall browser extension  
- Rewriting the visual editor around a new data model  

Those can come after customers use the HTML MVP.

---

## Timeline (target)

| When | Focus |
|------|--------|
| **Week 1** | Clone E1 → L1 → S1; write a short defect list (missing assets, broken layout, editor/export issues) |
| **Week 2** | Fix capture/crawl (sitemap, placeholders, auth gate) — see `docs/week1-defects.md` |
| **Week 3** | Smoke-test preview → save → share — see `docs/week3-smoke-test.md` |
| **Week 4** | Polish export; Vercel manual QA; ship MVP — see `docs/week4-ship.md` |

Adjust only if E1 is still badly broken after week 3.

---

## Working rules

1. **E1 first.** No broad refactors until E1 clone → edit → export works well.  
2. **No new architecture** unless a concrete E1/L1 bug requires it.  
3. **Prefer small fixes** in `capture.ts`, `rewriter.ts`, `crawler.ts`, `app.html`, `server.js`.  
4. **Measure with eyes + a short checklist**, not a large benchmark platform (optional light screenshots later).  

---

## Full flow checklist (per site)

- [x] Clone finishes (E1, L1, S1 — Week 2 benchmarks)
- [x] Home opens in preview/editor (API smoke — Week 3)
- [x] Images and CSS mostly present (spot-check; placeholders active)
- [x] Can navigate to at least one inner page (L1, S1; E1 is one-page)
- [x] Edit + save works (API + edit quota — Week 3/4 smoke)
- [x] Private share link works locally (production Vercel QA pending — Week 4)
- [x] Failed images show placeholder (not broken)
- [x] No blocker console errors on home (E1/L1; S1 has non-blocking React warnings)

---

## After MVP

Only then consider: better responsive capture, IR, codegen, real Figma export, motion, stricter QA — driven by real user feedback, not the full A/B spec up front.

---

## Related docs

- Longer analysis (architecture/gap history): `docs/TECHNICAL_UNDERSTANDING_REPORT.md`  
- Week 1 baseline defects: `docs/week1-defects.md`  
- Week 3 smoke test results: `docs/week3-smoke-test.md`  
- Week 4 ship checklist: `docs/week4-ship.md`  
- For MVP delivery, **this file takes priority**.
