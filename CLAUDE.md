# CLAUDE.md

Guidance for working in the Clonyfy **Backend** repository (API + cloner). The product UI is a separate Frontend repo

## Commands

```bash
npm install
npx playwright install chromium

# Build the CLI (packages/cloner → packages/cloner/dist/)
npm run build

# Start the API server (listens on $PORT, default 5000)
npm start

# Cloner CLI (after build)
node packages/cloner/dist/cli.js clone <url> [options]

# Dev without build
cd packages/cloner && npx tsx src/cli.ts clone <url> [options]
```

### CLI flags

| Flag | Default | Purpose |
|---|---|---|
| `--out <dir>` | `./output/site` | Output dir for generated Next.js project |
| `--max-pages <n>` | `50` | Page crawl cap |
| `--depth <n>` | `3` | BFS link depth |
| `--concurrency <n>` | `2` | Parallel Playwright browser contexts |
| `--ignore-robots` | off | Skip robots.txt check |

## Environment Variables

`server.js` requires these in `.env` (and in the Render dashboard for production):

| Variable | Required | Purpose |
|---|---|---|
| `SUPABASE_URL` | Yes | Supabase project URL |
| `SUPABASE_SERVICE_KEY` | Yes | Supabase service role key |
| `ADMIN_PASSWORD` | Yes | Admin API password — login disabled if unset |
| `PASSWORD_PEPPER` | Yes | Mixed into user password hashes |
| `SHARE_PASSWORD_PEPPER` | No | Share link password pepper |
| `PORT` | No | HTTP port (Render sets this automatically) |
| `APP_URL` | No | Public URL for email links; falls back to `RENDER_EXTERNAL_URL` |
| `CLONYFY_HOSTED` | No | Force hosted preview (`/api/page`); set automatically on Render |
| `CLONYFY_OUTPUT_DIR` | No | Clone output root (default `./output`; use a persistent disk path on Render) |
| `CLONYFY_SERVERLESS` | No | Opt-in Lambda-style limits; leave unset on Render |
| `STRIPE_*` / `SMTP_*` | No | Payments / email |

Stripe webhook URL: `https://<render-service>/api/stripe/webhook`

Google OAuth (`google_client_id` / `google_client_secret`) is configured via admin settings in the database (not env vars).

## Deploy (Render)

See `render.yaml` and `README.md`. Build: `npm install && npm run build && npx playwright install chromium`. Start: `npm start`. Health: `/api/health`.

## Architecture

```
/
├── server.js                 # API + job runner (vanilla JS)
├── db.js                     # Supabase data-access layer
├── render.yaml               # Render Blueprint
├── templates/emails/         # Transactional email templates
├── templates/starter-pages/  # Builder blank-site HTML seeds
├── figma-plugin/             # Figma Desktop import plugin
└── packages/
    ├── cloner/               # CLI pipeline (TypeScript)
    └── runtime/              # replay.js copied into generated apps
```

### Two deployables

- **Backend** (this repo): long-running Node on Render — APIs, clone jobs, exports.
- **Frontend** (sibling repo): marketing and product UI. Talks to Backend over HTTP.

### Clone pipeline (`packages/cloner/src/`)

Orchestrated by `runClone.ts`: robots → crawler → capture → rewriter → analyzer → generator.

### Safety constraints

- Same-origin links only; cross-origin assets downloaded but not crawled
- 250ms minimum delay between page navigations
- 30s per-page navigation timeout
- robots.txt enforced by default

## Known Issues

- `packages/cloner/src/crawler.ts` — pre-existing TypeScript cast warning; does not affect runtime
- No browser E2E suite; unit tests via `npm test` in `packages/cloner`
- Bundled JS with static `import` to CDNs cannot be rewritten by the replay patch
