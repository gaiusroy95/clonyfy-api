# Week 3 — smoke test report

**Date:** 2026-08-31  
**Engine:** `server.js` + Week 2 benchmark clones (`output/benchmarks/week2-{e1,l1}`)  
**Runner:** `npm run smoke:week3`

## What Week 3 covered

1. **Full-flow API smoke test** — preview, save, share for E1 + L1 benchmark clones  
2. **Auth gate** — anonymous `POST /api/clone` returns 401; UI prompts sign-in before clone  
3. **Quota resilience** — save/share work when `usage_events` table is not migrated yet (warns in logs; run `npm run db:migrate` for production quotas)  
4. **Share copy** — modal text updated for persistent private links (not “while server is running”)

## Reproduce

```bash
npm start                    # terminal 1
npm run smoke:week3          # terminal 2
```

Optional env overrides:

```bash
SMOKE_BASE_URL=http://127.0.0.1:5000
SMOKE_OUT_E1=output/benchmarks/week2-e1
SMOKE_OUT_L1=output/benchmarks/week2-l1
```

## Results — 25/25 passed

| Check | E1 | L1 |
|-------|----|----|
| Clone output exists | ✓ | ✓ |
| Preview requires auth | ✓ | ✓ |
| List pages | ✓ (3 routes) | ✓ (47 routes) |
| Preview home | ✓ ~506 KB | ✓ ~878 KB |
| Fallback fonts in HTML | ✓ | ✓ |
| Assets in preview | ✓ | ✓ |
| Preview inner page | n/a (1-page site) | ✓ `/offres` |
| Save page + persist | ✓ | ✓ |
| Create share link | ✓ | ✓ |
| Share page loads | ✓ | ✓ |
| Share styled content | ✓ | ✓ |

**Auth:** anonymous clone blocked (401) ✓

## MVP checklist status

| Item | E1 | L1 | S1 |
|------|----|----|-----|
| Clone finishes | ✓ | ✓ | ✓ (week2-s1) |
| Home opens in preview | ✓ | ✓ | ✓ |
| Images/CSS mostly present | ✓ (manual spot-check) | ✓ | ✓ |
| Navigate inner page | n/a (hash one-pager) | ✓ `/offres` | ✓ `/en-de/pricing` |
| Edit + save works | ✓ API | ✓ API | not run |
| Share link works | ✓ local | ✓ local | not run |
| Placeholder on failed images | ✓ | ✓ | ✓ |
| No blocker console errors | ✓ smoke run | ✓ smoke run | React minified errors (non-blocker) |

**Manual / Vercel still needed:** open `public/app.html` in browser on deployed Vercel, run one visual editor session per site, confirm share URL works on production domain.

## Ops note

Add `SUPABASE_DB_URL` to `.env` and run `npm run db:migrate` before launch so free-tier edit/save/share quotas are enforced in production. Without the table, quotas are skipped (logged warning) and all usage is allowed.

## Week 4 (ship)

- [ ] Visual editor smoke on Vercel (E1 home edit text → save → reload)  
- [ ] Production share link on `APP_URL`  
- [ ] `npm run db:migrate` on production Supabase  
- [ ] Final MVP sign-off in `docs/MVP.md`
