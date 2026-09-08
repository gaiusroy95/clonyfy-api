# Week 1 baseline — defect report

**Date:** 2026-08-31  
**Engine:** `packages/cloner` CLI (built dist), Playwright + system Edge  
**Options:** `--max-pages 25 --depth 3 --concurrency 2` (robots.txt respected)  
**Outputs:** `output/benchmarks/week1-{e1,l1,s1}/`

## Reproduce

```bash
npm install
npm install --prefix packages/cloner
npx playwright install chromium   # or use system Edge

node packages/cloner/dist/cli.js clone https://www.echeloninternational.ge --out output/benchmarks/week1-e1 --max-pages 25 --depth 3
node packages/cloner/dist/cli.js clone https://www.limova.ai --out output/benchmarks/week1-l1 --max-pages 25 --depth 3
node packages/cloner/dist/cli.js clone https://stripe.com --out output/benchmarks/week1-s1 --max-pages 25 --depth 3
```

---

## Summary

| Site | URL | Clone finished | Pages captured | Assets | MVP bar |
|------|-----|----------------|----------------|--------|---------|
| **E1** | echeloninternational.ge | Yes | **1** / 25 | 337 | **FAIL** — no inner pages |
| **L1** | limova.ai | Yes | **23** / 25 | 504 | **PASS_WITH_GAPS** — good coverage via sitemap |
| **S1** | stripe.com | Yes | **24** / 25 (home **failed**) | 316 | **FAIL** — wrong pages; home timed out |

**Week 1 goal (baseline + defect list):** done for measurement. **MVP acceptance:** not met on E1 or S1.

---

## E1 — echeloninternational.ge

### What worked

- Clone completed in ~53s without crash.
- Home page captured with **337 assets**, **0 failed assets** in manifest.
- Fonts and `_next/image` assets downloaded; hero images present in HTML.
- robots.txt allowed crawl.

### Defects

| ID | Severity | Area | Finding |
|----|----------|------|---------|
| E1-01 | **P0** | Crawl coverage | Only **1 page** captured. Log: `links_found=7` but no same-origin links enqueued. Site is Next.js with **client-side routing** — nav links not in static HTML for BFS. |
| E1-02 | **P1** | Coverage | No `/about`, `/services`, etc. — user cannot preview inner pages after clone. |
| E1-03 | **P2** | Sitemap | Sitemap check ran but did not add routes (unlike L1). Need sitemap-first or RSC link extraction for Next.js App Router sites. |
| E1-04 | **P3** | Product | `route-map.json` includes generated `/login`, `/register` stubs only — not real site pages. |

### Notes

- Home HTML uses local `/_assets/…` paths (good).
- External refs in captured HTML: minimal (~1 `src`/`href` still pointing off-origin).

---

## L1 — limova.ai

### What worked

- **23 pages** captured (sitemap had 23 URLs — excellent seed).
- Main marketing routes: home, agents, integrations, legal, contact, offres, etc.
- **504 unique assets** saved.
- robots.txt allowed crawl.

### Defects

| ID | Severity | Area | Finding |
|----|----------|------|---------|
| L1-01 | **P1** | Runtime JS | Console error on `/agent/julia`: `Loading chunk 729 failed` (Webflow CDN chunk `webflow.*.js`). Dynamic imports may break interactivity in clone. |
| L1-02 | **P1** | Assets | **~313** `src`/`href` still point to external URLs in captured HTML (CDN, Webflow). Rewriter did not localize all references. |
| L1-03 | **P2** | Route map | Duplicate keys (`/path` and `/path.html`) in `route-map.json` — harmless but noisy. |
| L1-04 | **P3** | Interactivity | Webflow/SPA behaviors (animations, forms) not validated in Week 1 — needs manual preview pass. |

### Notes

- Best baseline of the three sites for **page coverage**.
- Candidate for first MVP “green” site after asset rewrite fixes.

---

## S1 — stripe.com

### What worked

- Clone process completed (exit 0).
- **24 pages** captured with mostly consistent asset counts (~115/page).
- Sitemap discovered (**6617 URLs**).
- robots.txt allowed crawl.

### Defects

| ID | Severity | Area | Finding |
|----|----------|------|---------|
| S1-01 | **P0** | Crawl coverage | **`https://stripe.com/` timed out after 180s** — home page missing. MVP requires home. |
| S1-02 | **P0** | Wrong pages | Crawler followed sitemap into **`/legal/*`** subtree instead of marketing home/products. User gets legal docs, not stripe.com homepage. |
| S1-03 | **P1** | Assets | `/legal/api-key-security` captured with **0 assets** — empty/blocked page body. |
| S1-04 | **P1** | Assets | **~670** external `src`/`href` in HTML — heavy reliance on stripe.com CDN URLs in output. |
| S1-05 | **P2** | Scale | 6617 sitemap URLs — need **priority/allowlist** (homepage + top nav first), not naive BFS from sitemap. |
| S1-06 | **P2** | WAF/perf | Home timeout suggests bot protection or heavy JS — may need longer timeout, single-page seed, or “start URL only” mode for enterprise sites. |

### Notes

- Detected 2 API routes (cookie-settings, notifications) — stubs only.
- S1 is **stress test**, not MVP blocker if E1+L1 pass — but home timeout must be understood.

---

## Cross-cutting (all sites)

| ID | Severity | Area | Finding |
|----|----------|------|---------|
| X-01 | **P0** | Product | **Login required to clone** not implemented — `server.js` still allows anonymous clones. |
| X-02 | **P1** | Assets | **No placeholder image** when asset fetch fails — MVP requires “your pic” fallback. |
| X-03 | **P1** | Fonts | **No fallback font** injection for failed/premium fonts. |
| X-04 | **P2** | Crawl | **Next.js / client-nav sites** (E1): BFS on static `<a href>` insufficient — need sitemap seeding and/or post-hydration link discovery. |
| X-05 | **P2** | Crawl | **Large sitemaps** (S1): seed from **start URL + nav** before dumping legal URLs from sitemap. |
| X-06 | **P3** | Editor/export | Week 1 did not run app preview, edit/save, or Vercel share — deferred to Week 3 smoke test. |
| X-07 | **P3** | DB | `usage_events` migration tooling added; run `npm run db:migrate` after setting `SUPABASE_DB_URL`. |

---

## Week 2 priorities (recommended)

1. **E1-01 / X-04** — Sitemap + hydrated link extraction for Next.js (unlock inner pages on echeloninternational.ge).
2. **S1-01 / S1-02 / X-05** — Cap sitemap seeding: always capture start URL first; prioritize shallow nav links over `/legal/*`.
3. **L1-02 / S1-04** — Improve rewriter to catch remaining CDN `src`/`href` (or stub at replay time).
4. **X-02 / X-03** — Placeholder image + fallback font in `capture.ts` / `rewriter.ts`.
5. **X-01** — Require auth for `POST /api/clone`.

---

## Artifacts

| Site | Log | Manifest |
|------|-----|----------|
| E1 | `output/benchmarks/week1-e1/cloner.log` | `output/benchmarks/week1-e1/manifest.json` |
| L1 | `output/benchmarks/week1-l1/cloner.log` | `output/benchmarks/week1-l1/manifest.json` |
| S1 | `output/benchmarks/week1-s1/cloner.log` | `output/benchmarks/week1-s1/manifest.json` |
