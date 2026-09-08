# Clonyfy Backend

API server, clone pipeline, Stripe/auth, and Figma export tooling. The product UI lives in a separate Frontend repository.

## Install

```bash
npm install
npx playwright install chromium
npm run build
```

## Start the API

```bash
npm start
# listens on $PORT (default 5000)
```

Serves `/api/*`, clone preview/export, and related tooling. HTML product pages are not served here (HTTP 410 on former UI paths). Health check: `GET /api/health`.

## Deploy on Render

1. Push this Backend repo to GitHub/GitLab.
2. In [Render](https://dashboard.render.com), **New → Blueprint** and select the repo (uses `render.yaml`), or create a **Web Service** manually:
   - **Build command:** `npm install && npm run build && npx playwright install chromium`
   - **Start command:** `npm start`
   - **Health check path:** `/api/health`
   - **Node version:** 22
3. Set environment variables from `.env.example` (at minimum `SUPABASE_URL`, `SUPABASE_SERVICE_KEY`, `ADMIN_PASSWORD`, `PASSWORD_PEPPER`).
4. Set `APP_URL` to your Render service URL (e.g. `https://clonyfy-backend.onrender.com`), or rely on Render's `RENDER_EXTERNAL_URL`.
5. Point Stripe webhooks at `https://<your-service>/api/stripe/webhook`.

Optional: attach a persistent disk and set `CLONYFY_OUTPUT_DIR` to that mount path so clone output survives deploys.

## Cloner CLI

```bash
node packages/cloner/dist/cli.js clone <url> [options]
```

| Flag | Default | Description |
|---|---|---|
| `--out <dir>` | `./output/site` | Generated Next.js project output |
| `--max-pages <n>` | `50` | Maximum pages to crawl |
| `--depth <n>` | `3` | Maximum link depth |
| `--concurrency <n>` | `2` | Parallel browser contexts |
| `--ignore-robots` | off | Skip robots.txt enforcement |

## Layout

```
server.js         HTTP API + job runner
db.js             Supabase data access
packages/cloner/  Crawl / capture / generate pipeline
packages/runtime/ Replay helper copied into generated apps
lib/              Figma export, preview patches
templates/emails/ Transactional email HTML
templates/starter-pages/  Builder blank-site seeds
figma-plugin/     Clonyfy Import plugin for Figma Desktop
supabase/         Migrations / config
render.yaml       Render Blueprint
```
