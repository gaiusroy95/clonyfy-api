# V1 production deploy (Clone / Editor / Figma / GitHub / ZIP)

## Backend (Render)

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

### Durable clone storage (important)

Clones must land in **Supabase Storage** (`clone-files` bucket). Render disk is ephemeral — after a restart, only Storage-backed clones stay previewable.

The Backend now:
- Uploads critical HTML during / after the crawl (and mid-clone on hosted)
- Refuses to mark a clone **Complete** unless Storage verify passes
- Remaps `outDir` by folder name if the absolute path changed after redeploy

Confirm in Supabase that the `clone-files` bucket exists and the service role can upload. Check Render logs for `[clone storage]`.

### Keep-warm (free tier cold starts)

Render free web services sleep after idle. The Frontend already:

- Pings `GET /api/health` before login/clone and retries on 502/503/504
- Keep-warms every ~8 minutes while the dashboard auth session is open

For always-warm when no one is using the site, add an external monitor (UptimeRobot, cron-job.org, etc.) hitting:

`https://YOUR-API.onrender.com/api/health`

every **5–10 minutes**. Health returns `{ ok, lowMemory, cloneConcurrency, memory }`.

## Frontend (Vercel)

1. Set `VITE_API_BASE_URL` to the Backend URL and **rebuild** (Vite bakes this at build time).
2. Deploy the Frontend so wake/retry + keep-warm code is live.

## Smoke checklist

- Cold start: open login → may wait ~30–90s once, then succeeds (not a stuck spinner forever)
- Start clone → Complete (or Failed with real error, never fake Complete)
- Edit pages → Save → preview reflects changes
- Download ZIP (paid) — still works if Next regen fails (captured HTML fallback)
- Figma SVG / ZIP (paid)
- GitHub push (paid + PAT)
