# V1 production deploy (Clone / Editor / Figma / GitHub / ZIP)

## Backend (Vercel — recommended)

Deploy the **Backend folder/repo as its own Vercel project** (separate from the Frontend site). Frontend keeps `VITE_API_BASE_URL` pointed at this API URL (e.g. `https://api.clonyfy.com`).

### Constraints

- Use **Vercel Pro** (or Fluid) so `maxDuration` can be **300s**. Hobby timeouts are too short for Playwright clones.
- Clones run **inline** with `@sparticuz/chromium` + `waitUntil` (no child `spawn`).
- Cap pages via `CLONYFY_SERVERLESS_MAX_PAGES` (default **5** on Vercel). Large Shopify-style sites may still fail or salvage partial HTML.
- Disk is ephemeral (`/tmp`); durable files must live in **Supabase Storage**.

### Setup

1. Create a new Vercel project from the Backend repo (Root Directory = Backend if monorepo).
2. Build uses `vercel.json`: `npm install` + `npm run build` (builds `@clonyfy/cloner`). Function entry: `api/index.js` → shared `server.js` handler.
3. Set env (see `.env.example`):

| Variable | Notes |
|---|---|
| `CLONYFY_QUALITY=1` | **Default.** Near-identical capture (desktop budgets, live media URLs). Set `0` only for emergency low-RAM |
| `CLONYFY_PREFER_LIVE_MEDIA=1` | Opt-in CDN hotlink (not recommended; causes font CORS). Default is local `/_assets` |
| `CLONYFY_SERVERLESS=1` | Explicit serverless mode (also auto-detected via `VERCEL`) |
| `CLONYFY_HOSTED=1` | Hosted preview paths |
| `CLONYFY_LOW_MEMORY=1` | Soft concurrency / exports (auto-on for Vercel unless `=0`) |
| `CLONYFY_SERVERLESS_MAX_PAGES=5` | Page budget per clone (use 1–3 for max quality) |
| `CLONYFY_FAST_CLONE=1` | **Avoid** — emergency only; hurts images/animations |
| `APP_URL` | Public API URL (e.g. `https://api.clonyfy.com`) |
| `FRONTEND_URL` | Live Frontend origin (CORS + redirects) |
| Supabase / Stripe / auth | Same as local — `SUPABASE_*`, `ADMIN_PASSWORD`, peppers, etc. |

4. Optional: `CLONYFY_CLONE_DEADLINE_MS` (Vercel default ~**240000** ms to fit `maxDuration` 300s).
5. Point a custom domain at the Backend project if desired.

Local development stays `npm run dev` / `node server.js` (binds a port; skips listen only when `VERCEL` is set).

### Durable clone storage (required on Vercel)

Clones must land in **Supabase Storage** (`clone-files` bucket). Function filesystem is wiped when the isolate ends — only Storage-backed clones stay previewable.

The Backend:
- Uploads critical HTML during / after the crawl (and mid-clone on hosted/serverless)
- Refuses to mark a clone **Complete** unless Storage verify passes
- Remaps `outDir` by folder name if the absolute path changed after redeploy

Confirm the `clone-files` bucket exists and the service role can upload. Check function logs for `[clone storage]`.

---

## Backend (Render — optional / legacy)

Render is **not required** once the Vercel Backend is live. Keep this section if you still run a dedicated Node host.

1. Deploy from the Backend repo so `npm run build` rebuilds `@clonyfy/cloner`.
2. Required env:
   - `APP_URL` = public API URL (e.g. `https://clonyfy-api.onrender.com`)
   - `FRONTEND_URL` = live site (e.g. `https://www.clonyfy.com`)
   - Supabase + auth secrets as in `.env.example`
3. Blueprint defaults (`render.yaml`):
   - `CLONYFY_HOSTED=1`
   - `CLONYFY_FAST_CLONE=1`
   - `CLONYFY_CLONE_CONCURRENCY=1` (safer on Free/Starter RAM)
   - `CLONYFY_LOW_MEMORY=1` (softer deadlines, capped Figma ZIP pages, ZIP/GitHub fall back if Next regen OOMs)
4. Optional: `CLONYFY_CLONE_DEADLINE_MS` (low-memory default ~12 minutes; otherwise ~18).
5. On more RAM, set `CLONYFY_LOW_MEMORY=0` and raise `CLONYFY_CLONE_CONCURRENCY` to `2`.

After deploy, a small clone (about 10 pages or fewer) should finish in about **2-5 minutes**.

### Keep-warm (Render free tier cold starts)

Render free web services sleep after idle. The Frontend already:

- Pings `GET /api/health` before login/clone and retries on 502/503/504
- Keep-warms every ~8 minutes while the dashboard auth session is open

For always-warm when no one is using the site, add an external monitor hitting:

`https://YOUR-API.onrender.com/api/health`

every **5–10 minutes**. Health returns `{ ok, lowMemory, cloneConcurrency, memory }`.

## Frontend (Vercel)

1. Set `VITE_API_BASE_URL` to the **Backend Vercel URL** (or custom API domain) and **rebuild** (Vite bakes this at build time).
2. Deploy the Frontend so wake/retry + keep-warm code is live.

Do **not** merge Frontend and Backend into one Vercel project for this setup — they stay separate.

## Smoke checklist

- Health: `GET /api/health` on the Backend project
- Start clone → Complete (or Failed with real error, never fake Complete); expect page caps on Vercel
- Edit pages → Save → preview reflects changes
- Download ZIP (paid) — still works if Next regen fails (captured HTML fallback)
- Figma SVG / ZIP (paid)
- GitHub push (paid + PAT)
