# V1 production deploy (Clone / Editor / Figma / GitHub / ZIP)

## Backend (Render)

1. Deploy from the Backend repo so `npm run build` rebuilds `@clonyfy/cloner`.
2. Required env:
   - `APP_URL` = public API URL (e.g. `https://clonyfy-api.onrender.com`)
   - `FRONTEND_URL` = live site (e.g. `https://www.clonyfy.com`)
   - Supabase + auth secrets as in `.env.example`
3. Blueprint defaults (`render.yaml`): `CLONYFY_HOSTED=1`, `CLONYFY_FAST_CLONE=1`, `CLONYFY_CLONE_CONCURRENCY=2`.
4. Optional: `CLONYFY_CLONE_DEADLINE_MS` (default ~18 minutes).

After deploy, a small clone (about 10 pages or fewer) should finish in about **2-5 minutes**.

## Frontend (Vercel)

1. Set `VITE_API_BASE_URL` to the Backend URL and **rebuild** (Vite bakes this at build time).
2. Deploy the Frontend so `/dashboard/editor` and Capture actions are live.

## Smoke checklist

- Start clone → Complete (or Failed with real error, never fake Complete)
- Edit pages → Save → preview reflects changes
- Download ZIP (paid)
- Figma SVG / ZIP (paid)
- GitHub push (paid + PAT)
