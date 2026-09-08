# Week 4 — ship checklist

**Date:** 2026-08-31  
**Goal:** Polish export, validate production paths, sign off MVP.

## Automated checks (local)

```bash
npm start
npm run smoke:week3   # preview + save + share (E1, L1)
npm run smoke:week4   # edit quota, share host, ZIP export gate
```

**Week 4 smoke: 12/12 passed**

| Check | Result |
|-------|--------|
| Edit quota consume | ✓ |
| Editor save round-trip | ✓ |
| Share URL uses request host (local) | ✓ |
| Share page loads | ✓ |
| Free user blocked from ZIP | ✓ |
| Paid user ZIP build + download (valid PKZIP) | ✓ |

## Code changes (Week 4)

1. **`publicAppUrl()`** — local requests use `localhost`/`127.0.0.1` for share links instead of production `APP_URL`; `SHARE_BASE_URL` override supported.
2. **`npm run smoke:week4`** — ship smoke script for edit/export/share host.
3. **Session cache** — admin plan changes already invalidate cached sessions; smoke test re-logins after direct DB upgrade.

## Pre-launch (manual on Vercel)

### 1. Database migration

```bash
# Add to Vercel + local .env:
SUPABASE_DB_URL=postgresql://postgres.[ref]:[password]@...

npm run db:migrate
```

Creates `usage_events` table for free-tier edit/save/share quotas. Without it, quotas are skipped (logged warning).

### 2. Vercel environment

| Variable | Required |
|----------|----------|
| `SUPABASE_URL` | ✓ |
| `SUPABASE_SERVICE_KEY` | ✓ |
| `SUPABASE_DB_URL` | ✓ (migrations) |
| `ADMIN_PASSWORD` | ✓ |
| `PASSWORD_PEPPER` | ✓ |
| `SHARE_PASSWORD_PEPPER` | ✓ |
| `APP_URL` | ✓ `https://clonyfy.com` |
| `PUBLIC_APP_URL` | optional canonical |

### 3. Production smoke (browser)

On `https://clonyfy.com` after deploy:

- [ ] Sign in → clone a URL (auth required)
- [ ] Preview home renders with images/fonts
- [ ] Editor: change headline text → Save → reload → change persists
- [ ] Share link opens in incognito (no login)
- [ ] Free user hits save/share limit after 2 uses (after migration)
- [ ] Paid user can Export ZIP

### 4. Benchmark acceptance

| Site | Clone | Preview | Inner pages | Notes |
|------|-------|---------|-------------|-------|
| **E1** echeloninternational.ge | ✓ | ✓ | n/a (one-pager) | Hash nav only |
| **L1** limova.ai | ✓ 23/25 | ✓ | ✓ | `/agent/julia` empty |
| **S1** stripe.com | ✓ | ✓ home | ✓ marketing | React console warnings OK |

## MVP sign-off

| Criterion | Status |
|-----------|--------|
| Auth required to clone | ✓ |
| E1 + L1 + S1 clone without crash | ✓ |
| Placeholder + fallback fonts | ✓ |
| Preview + save + share (API) | ✓ |
| ZIP export (paid) | ✓ |
| Share on production Vercel | **pending manual QA** |
| Usage quotas in production | **pending `db:migrate`** |

**Recommendation:** Ship after Vercel browser QA + `db:migrate` on production Supabase.
