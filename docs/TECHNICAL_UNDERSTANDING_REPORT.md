# Clonyfy — Technical Understanding Report

**Document type:** Pre-implementation understanding (evidence-based)  
**Date:** 2026-08-29  
**Scope:** Verified repository behavior + agreed architecture/planning from analysis sessions  
**Status:** Understanding is **substantially complete for current product and MVP direction**, with **explicit residual uncertainties** listed in §12. This report does **not** claim full understanding of unverified runtime behavior on the three benchmark sites (clones were planned, not executed in-repo as a scored baseline).

---

## 1. Executive summary

Clonyfy today is a **Playwright-based HTML snapshot cloner** packaged as a SaaS (`server.js` + Supabase + Stripe) with an **iframe HTML visual editor**. The client specification (Algorithms A and B) describes a different product: **computed-style IR → React/Tailwind + motion + 99% visual QA + native Figma plugin**.

The agreed bridge is a **shared Intermediate Representation (IR)** with **dual-write**: keep `route-map.json` + `captured-pages/*.html` + `public/_assets/**` for the working editor, while building Algorithms A/B on IR. Implementation should start with a **benchmark harness** on three acceptance sites before engine changes.

---

## 2. Current architecture (verified)

### 2.1 Repository layout

| Area | Path | Role |
|------|------|------|
| Product HTTP API + static UI | `server.js` (~4.6k LOC) | Auth, billing, clone jobs, preview, editor APIs, deploy/share |
| DB / storage | `db.js` | Supabase tables + `clone-files` storage |
| Vercel entry | `api/index.js` → `server.js` handler | Serverless adapter (`vercel.json`, 300s) |
| Clone pipeline | `packages/cloner/src/*` | robots → crawl → capture → rewrite → analyze → generate |
| Generated-app templates | `packages/cloner/templates/*.hbs` | Next shell serving HTML snapshots + API fixtures |
| Fixture helper | `packages/runtime/src/replay.js` | Simpler than `replay.ts.hbs` used at generate time |
| Visual editor | `public/app.html` | Mutates iframe HTML; saves full document |
| Marketing source | `landing/` | Built to static `public/landing.html` (not the product runtime) |
| Schema | `supabase-schema.sql` | users, sessions, clones, shares, payments, etc. |
| Alternate CLI UI | `packages/cloner/src/_server.ts` | Not production; `cloner serve` only |

**Not present:** `netlify.toml` for hosting this product; Netlify is a **user deploy target** for cloned static sites. Root `package.json` has **no** `workspaces` field (CLAUDE.md claims workspaces — **doc drift**).

### 2.2 Clone pipeline (data flow)

```
POST /api/clone (server.js)
  → plan limits, SSRF guard, insertClone, job
  → USE_INLINE_CLONE ? runClone() : spawn(cli.js)
       runClone.ts
         checkRobots (robots.ts)
         crawl (crawler.ts) → capturePage (capture.ts)
           page.route → assets + NetworkEntry[]
           goto / scroll / lazy promote / optional clicks
           html = page.content()
         onPage → rewriteHtml (rewriter.ts) → captured-pages + route-map
         analyzeTraffic (analyzer.ts) → ApiRouteSpec[]
         generateNextApp (generator.ts) → Next shell + fixtures
  → persistCloneOutput → verify → job status done|error
```

**Key types today** (`packages/cloner/src/types.ts`): `ClonerOptions`, `PageRecord`, `AssetEntry`, `NetworkEntry`, `Manifest`, `ApiRouteSpec`. No computed-style, breakpoint, motion, or QA score types.

### 2.3 Editor / preview contract (must preserve)

| API | Contract |
|-----|----------|
| `GET /api/pages?outDir=` | JSON array of route strings from `route-map.json` |
| `GET /api/page?outDir=&route=` | HTML after preview asset rewrite |
| `POST /api/save-page` | `{ outDir, route, html }` → overwrite `captured-pages/<file>` |
| `POST /api/import-asset` | data URL → `public/_assets/user-*.ext` → `{ path: "/_assets/..." }` |

Editor model: **no scene graph** — `srcdoc` iframe, DOM mutation, save `documentElement.outerHTML`. Scripts disabled in editor via `prepareEditorHtml`.

### 2.4 Deploy / export (verified)

| Feature | Status |
|---------|--------|
| ZIP / static materialize | Implemented (`buildOutputZip` / `materializeStaticWebsite`) |
| Netlify deploy | Implemented (`POST /api/deploy/netlify`) |
| GitHub push | Implemented (full project tree) |
| Vercel deploy UI | Placeholder toast (“coming soon”) |
| Share links | Implemented (`/api/share/create`, `/share/:id`) |
| “Figma export” | **SVG download** (`exportFigmaSvg` in `app.html`), not Figma plugin |

Progress: **polling** `GET /api/status` (not SSE in `server.js`). SSE exists only in `_server.ts`.

---

## 3. Current working functionality

### 3.1 Fully working (code-backed)

- Multi-page same-origin crawl (Playwright; static fallback)
- Post-JS-render **HTML snapshots** + asset download/rewrite to `/_assets`
- Incremental `route-map` / crash salvage
- API traffic → fixture stubs + optional Prisma model stubs (TODO wire-up)
- SaaS: auth (password/Google), plans, Stripe, admin, emails
- Visual HTML editor (select/style/move/resize/layers UI/undo/save) — paid gates for edit/save/export
- Preview (hosted `/api/page` or local `npm run dev`)
- ZIP, Netlify, GitHub, share
- robots.txt check (overridable)
- Unit tests: analyzer, rewriter, crawler helpers, cssUrls, `safeName`

### 3.2 Partially working / different from marketing

- “SPA support”: render-and-freeze + importmap/fetch patches; static ESM CDN imports not rewritten
- “Figma export”: flat SVG approximation
- Responsive: single capture viewport **1440×900**; editor only CSS-squeezes width
- Forms/backend: fixture replay, not real business logic
- iframes: often blanked; not recursively cloned
- Canvas/WebGL: not pixel-captured
- Shadow DOM: not systematically flattened

### 3.3 Documented but mismatched

| Claim | Reality |
|-------|---------|
| npm workspaces monorepo | No `workspaces` in root `package.json` |
| SSE clone progress | Polling `/api/status` |
| Distinct `popular` plan | Aliased to `growth` |
| Product on Netlify | Product on Vercel; Netlify = clone publish |

---

## 4. Client’s requested end state

### Algorithm A — Frontend Clone Engine

| Step | Intent |
|------|--------|
| A1 | `getComputedStyle` + bounds per element; multi-breakpoint |
| A2 | Full asset/font/SVG/video pipeline |
| A3 | Motion detection (CSS, GSAP/Framer/Lottie, scroll, hover) |
| A4 | Semantic React + Tailwind (+ motion layer) |
| A5 | Pixel/motion diff; **≥99%** fidelity; review queue |
| A6 | Repeat A1–A5 per breakpoint (e.g. 375 / 768 / 1440) |
| A7 | Layout-aware asset replacement |
| A8 | Font licensing + open-source fallback |
| A9 | Lighthouse-style performance optimization |
| A10 | Human-in-the-loop for WebGL/canvas edge cases |
| A11 | robots, login-wall handling, legal/DMCA, no auth bypass (extension for logged-in) |

### Algorithm B — Figma Export Engine

| Step | Intent |
|------|--------|
| B1 | Scene-graph JSON (Frame/Text/Vector/Image, Auto Layout inference) |
| B2 | **Figma Plugin API** (not REST create) |
| B3 | Native styles + Smart Animate where applicable |
| B4 | Image/vector ingestion onto canvas |

**Acceptance benchmarks (agreed):**

1. https://www.echeloninternational.ge (E1)  
2. https://www.limova.ai (L1)  
3. https://stripe.com/ (S1)  

Numeric gates (proposed, not yet measured in-repo): completeness G0; desktop static scores ~72/65/55 for E1/L1/S1; tablet/mobile lower under snapshot mode; **not** “looks perfect.”

---

## 5. Exact gap

| Requirement | Current | Gap |
|-------------|---------|-----|
| A1 Computed DOM | `page.content()` only | No per-element computed style IR |
| A2 Assets | Network save + CSS url rewrite | No structured font license / SVG protocol as specified |
| A3 Motion | Preserve original CSS/JS if present | No motion model / reconstruction |
| A4 React+Tailwind | HTML Response in Next shell | No semantic component codegen |
| A5 99% QA | Log-based “health” counts | No SSIM/screenshot pipeline |
| A6 Responsive | One viewport | No multi-BP capture |
| A7 Smart replace | Editor URL/file swap | No object-fit/box metadata model |
| A8 Fonts | Download if requested | No licensing substitution |
| A9 Perf | Size caps / abort trackers | No Lighthouse pass |
| A10 HITL | Admin ops only | No fidelity queue / canvas fallbacks |
| A11 Legal | robots + AUTH_PATH skip + ToS HTML | No bookmarklet; ignore-robots available |
| B1–B4 Figma | SVG download | No scene JSON, no plugin |

**Critical distinctions:**

- Captured **HTML** ≠ semantic **React/Tailwind**  
- Preserved scripts ≠ reconstructed **motion**  
- **SVG download** ≠ editable **Figma plugin**  
- Visual similarity ≠ measured **99%** score  

---

## 6. Proposed architecture

### 6.1 Principle

Introduce a **canonical IR** (`packages/ir`). Every clone **dual-writes**:

1. **Compat projection:** `route-map` + `captured-pages` + `_assets` (editor/ZIP/Netlify/share)  
2. **IR:** `ir/project.json` + `ir/pages/*.json` (+ later `figma/scene.json`, `qa/`, `generated/`)

### 6.2 Flow

```
Playwright capture
  → extract scene/styles/motion/fonts (flags)
  → write IR
  → existing rewriteHtml + generateNextApp (unchanged contract)
  → projectors: React codegen | QA screenshots | Figma scene | editor (HTML first)
```

### 6.3 Feature flags (recommended)

`CLONYFY_EXTRACT_SCENE`, `CLONYFY_IR`, `CLONYFY_CODEGEN`, `CLONYFY_QA`, breakpoints on serverless off by default.

### 6.4 What stays unchanged vs extends vs new

| Unchanged | Extend | New |
|-----------|--------|-----|
| Editor HTML APIs | `capture.ts`, `crawler.ts`, `runClone.ts` | `packages/ir` |
| robots base | `generator.ts`, `server.js` persist | `ir/extract*`, `codegen/*`, `qa/*`, `figma/*` |
| ZIP/Netlify HTML path | `manifest.json` fields | `benchmarks/*`, `packages/figma-plugin` |
| `_server.ts` legacy | `app.html` (label SVG; IR badge later) | |

---

## 7. Shared data model (summary)

Canonical types (full field lists in planning docs / future `packages/ir/src/types.ts`):

- **Project** — origin, breakpoints, page refs, assets, fonts, tokens, components, legal, QA, Figma meta  
- **Page** — route, `scenes[breakpointId]`, interactions, animations, htmlSnapshot pointer, QA  
- **Breakpoint** — id, width, height  
- **Scene** — rootId, nodes map, viewport metrics  
- **SceneNode** — frame | text | image | vector | media | unknown; bounds; styles; layout; flags; figma meta  
- **ComputedStyleSet** — display/position/typography/box/border/shadow/transform/…  
- **LayoutConstraints** — flex/grid/absolute + Figma Auto Layout fields + A7 aspect constraints  
- **Asset / FontFace** — localPath, mime, dims, license  
- **InteractionState / AnimationDefinition** — A3  
- **ComponentDefinition** — A4 semantic grouping  
- **FigmaNodeMeta / FigmaProjectMeta** — B1–B4  
- **PageQaResult** — scores per breakpoint, belowThreshold  

**Editor compatibility rule:** `Page.route` must remain the `route-map` key; HTML filenames continue via `safeName(route)`.

---

## 8. Implementation phases (condensed)

| # | Phase | MVP? | Est. |
|---|-------|------|------|
| 1 | Baseline + automated benchmark harness (E1→L1→S1) | Yes | 1.5–2.5 w |
| 2 | Computed DOM/style extraction (desktop) | Yes | 2–3 w |
| 3 | Shared IR package + dual-write | Yes | 2–3 w |
| 4 | Responsive extraction (1440/768/390) | Yes | 2–3 w |
| 5 | Improved codegen (HTML/CSS tokens and/or React+TW lite) | Yes | 3–4 w |
| 6 | Visual comparison + safe repair loop (gates ≠ 99%) | Yes | 2.5–3.5 w |
| 7 | Supported motion extraction (CSS/hover/scroll; no full GSAP rewrite) | Post-MVP | 3–4 w |
| 8 | Editor integration (IR status/QA; HTML save primary) | Yes | 1.5–2.5 w |
| 9 | Figma scene-graph generator | Post | 2.5–3.5 w |
| 10 | Figma plugin | Post | 3–5 w |
| 11 | Security, performance, production hardening | Parallel | 2–3 w+ |

**MVP checkpoint:** Phases 1–6 + 8; E1 PASS; L1 PASS or PASS_WITH_GAPS; S1 scored.  
**MVP engineer-weeks:** ~15–22 (one engineer ≈ 4–5.5 months).

### Deferred from MVP

Full Figma plugin; GSAP/Framer/Lottie reconstruction; ≥99% + human queue; full A8 metric font fallback; WebGL/canvas video fallback; auth-session extension; IR-first editor rewrite; arbitrary-site SLA; replacing HTML shell with React-only; serverless multi-BP by default.

---

## 9. Benchmark strategy (three sites)

### 9.1 Sites

| ID | URL | Role |
|----|-----|------|
| E1 | echeloninternational.ge | Primary acceptance every phase |
| L1 | limova.ai | SPA/cookies/video complexity |
| S1 | stripe.com | Scale / WAF / stress (non-blocking early) |

### 9.2 Method (M-SNAPSHOT default)

- Clone with frozen flags (`max-pages` 30, `depth` 3, `concurrency` 1)  
- Screenshots: **1440×900**, **768×1024**, **390×844** × hero/mid/footer  
- Metrics: SSIM-weighted `static_score` 0–100; MAE; edge F1; hist corr  
- Gates: **G0** complete; **G1** desktop scores ≥72/65/55; **G2** assets/errors; **G3** tablet/mobile lower thresholds  
- Motion/hover: **measured, non-blocking** for current engine  
- Editor smoke: pages → load → save round-trip  
- Artifacts: `report.json` + `REPORT.md` + suite `SUMMARY.md`

### 9.3 What has not been verified yet

**No scored baseline-v0 run is stored in this repository from our sessions.** Site-specific scores, WAF blocks, and flakiness are **hypotheses** until Phase 1 executes.

---

## 10. Contradiction check (prior conclusions)

| Topic | Resolution |
|-------|------------|
| Saving “free” vs paid | **Paid.** Server `isPaidPlan` on `/api/save-page`; client `requirePaid`. Stale comment in `app.html` contradicted code — **code wins**. |
| SSE vs polling | CLAUDE.md SSE claim vs `server.js` — **polling is production**. |
| Workspaces | Docs vs package.json — **not workspaces**. |
| Figma | UI “Figma export” vs SVG — **SVG only**. |
| Netlify | Skills/router vs repo — **product = Vercel**; Netlify = clone deploy. |
| React output | Generated apps depend on React/Next but **serve HTML strings**, not component trees. |
| `packages/runtime` vs `replay.ts.hbs` | Generator uses **template**; runtime package is parallel/simpler — don’t assume they stay in sync. |
| Popular plan | Aliased to growth — not a separate `PLAN_LIMITS` entry. |

No unresolved contradiction remains that would reverse the gap analysis; remaining issues are **uncertainties**, not contradictions.

---

## 11. Major risks and assumptions

### Risks

1. S1 (and possibly L1) blocked or heavily bot-challenged → FAIL/LEGAL_BLOCK skews roadmap  
2. IR size/time on enterprise DOMs (S1) without budgets  
3. Dual-write drift after editor HTML save (IR stale)  
4. Screenshot flakiness (cookies, fonts, motion)  
5. Claiming A/B “done” before gates rise above baseline  
6. Serverless `/tmp` + Chromium limits vs multi-BP extract  
7. Legal: `--ignore-robots` vs A11 narrative  

### Assumptions

1. HTML snapshot + editor remain the commercial UX through MVP  
2. E1 is the primary quality bar; S1 is stretch  
3. MVP QA thresholds are baseline gates, **not** 99%  
4. Figma Plugin API is required for B (REST cannot create nodes)  
5. Benchmarks run primarily on a **dedicated local/long-running** runner, not only Vercel  

---

## 12. Unanswered questions / incomplete understanding

The following are **not fully known** from repository evidence alone. Implementation should not pretend otherwise:

1. **Actual baseline scores** for E1/L1/S1 under the proposed harness (not run/stored here).  
2. Whether **S1** allows unauthenticated archival crawl at useful coverage without WAF failure.  
3. Product owner priority if dual-write conflicts: **HTML editor fidelity** vs **IR/React/Figma** when they diverge after save.  
4. Target hosting for clone workers long-term: local-only, always-on worker, or Vercel-inline only.  
5. Whether A4 MVP should prefer **CSS variables + semantic HTML** or **React+Tailwind** as the first codegen (both proposed; decision open).  
6. Auth model for Figma plugin Task ID fetch (session cookie vs API token vs public share).  
7. Whether production must **disable** `--ignore-robots` in the UI.  
8. SLA: max pages/time for “enterprise” clones under new extract costs.  
9. Ownership of DMCA/takedown **process** beyond static ToS pages.  
10. Whether `_server.ts` / `cloner serve` is retired or kept for internal tools.  

**Statement:** Understanding of the **current codebase architecture and the gap to Algorithms A/B** is sufficient to start Phase 1. Understanding of **live fidelity on the three benchmarks and final product policy choices above** is **incomplete** until Phase 1 runs and stakeholders answer §12.

---

## 13. Recommended first coding task

**Phase 1 — Benchmark harness only (no engine behavior change).**

Deliverables:

1. Create `benchmarks/` with `sites/E1.yaml`, `L1.yaml`, `S1.yaml`, `run-site.mjs`, `shots.mjs`, `score.mjs`, report schema  
2. Run against E1 first; produce `report.json` + `REPORT.md`  
3. Establish `baseline-v0` commit/folder for E1 (then L1, then S1)  
4. Document reproduce steps in `benchmarks/README.md`  

**Exit criteria for starting Phase 2:** E1 harness is reproducible by a second engineer; G0 fields populated; desktop screenshots + scores exist; known failures classified (asset/motion/responsive) without changing `capture.ts`.

---

## 14. Evidence index (primary files)

| Concern | Evidence |
|---------|----------|
| Orchestration | `packages/cloner/src/runClone.ts` |
| Viewport 1440×900 | `packages/cloner/src/crawler.ts` |
| Snapshot = `page.content()` | `packages/cloner/src/capture.ts` |
| Types | `packages/cloner/src/types.ts` |
| HTML serve / replay patch | `packages/cloner/templates/page.tsx.hbs` |
| API fixtures | `packages/cloner/templates/route.ts.hbs`, `analyzer.ts` |
| Clone API / persist | `server.js` (`/api/clone`, `persistCloneOutput`, save-page) |
| Editor / Figma SVG | `public/app.html` (`loadEditorPage`, `savePage`, `exportFigmaSvg`) |
| robots | `packages/cloner/src/robots.ts` |
| Auth path skip | `packages/cloner/src/pageUrls.ts` `AUTH_PATH` |
| Deploy | `server.js` `/api/deploy/netlify`, `/api/github/*` |
| Vercel | `vercel.json`, `api/index.js` |

---

## 15. Document control

| Item | Value |
|------|--------|
| Authoring basis | Repository read-only analysis + planning conversation |
| Implementation | **Not started** by this document |
| Next action | Stakeholder ack of §12 + execute §13 (Phase 1 harness) |

---

*End of Technical Understanding Report.*
