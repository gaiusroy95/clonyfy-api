# Publish Clonyfy Import to Figma Community

Customers cannot use a local Development plugin. Production requires a **published Community plugin**.

Official guide: https://help.figma.com/hc/en-us/articles/360042293394-Publish-classic-plugins-to-the-Figma-Community

## Prerequisites

1. Figma Desktop (macOS or Windows)
2. Two-factor authentication enabled on your Figma account
3. This folder imported once as a Development plugin (for testing)

## One-time: get a real plugin ID

1. Open any design file in Figma Desktop  
2. **Plugins → Development → Import plugin from manifest…** → select this folder’s `manifest.json`  
3. **Plugins → Manage plugins…** → find **Clonyfy Import** → **⋯ → Publish**  
4. If Figma shows **Invalid ID** / **Generate ID**, copy the generated ID  
5. Paste it into `manifest.json` as `"id": "<generated-id>"`  
6. Save, then continue the publish flow  

Do **not** ship the placeholder id `clonyfy-import-dev` to Community.

## Listing assets (ready in `assets/`)

| Asset | Size | File |
|---|---|---|
| Icon | 128×128 | `assets/icon-128.svg` → export PNG in Figma/design tool |
| Cover / thumbnail | 1920×1080 | `assets/cover-1920x1080.svg` → export PNG |

Figma’s publish modal wants **PNG** (or similar raster). Open the SVGs in Figma (or any exporter) and export PNG before upload.

Copy for the listing is in `community-listing.md`.

## Publish steps

1. Smoke-test: run plugin → **Import sample** → layers appear  
2. Smoke-test: export a page from Clonyfy → clipboard → open plugin → auto-import  
3. **Manage plugins → Publish**  
4. Fill name / tagline / description / category (**Design tools** or **Software development**)  
5. Upload icon + cover  
6. Network access should show **Unrestricted** (we fetch image URLs from cloned sites / CDNs). Reasoning is already in `manifest.json`  
7. Support contact: your Clonyfy support email  
8. Publish to **Community** (free)  
9. Wait for review (can take days; email from Figma)

## After approval

1. Open the Community listing → copy URL  
   Example shape: `https://www.figma.com/community/plugin/<id>/Clonyfy-Import`  
2. Set on the Clonyfy server:

```bash
FIGMA_COMMUNITY_PLUGIN_URL=https://www.figma.com/community/plugin/<id>/Clonyfy-Import
```

3. Redeploy Clonyfy so the Export Figma modal shows **Install Clonyfy Import** for customers  
4. Verify: fresh Figma account → install from Community → Export from Clonyfy → run plugin → layers import  

## Customer flow (after publish)

1. Install **Clonyfy Import** once from Figma Community (Desktop or Web)  
2. In Clonyfy: **Export for Figma Desktop** (copies Scene Graph)  
3. In Figma: **Plugins → Clonyfy Import** (or Run last plugin)  
4. Plugin auto-imports from clipboard  

Web-only users without the plugin can still **Download SVG for Figma Web**.

## Updates

After code changes: **Manage plugins → Publish update**. Keep the same `id` in `manifest.json`.

## Review tips

- Do not request unnecessary permissions  
- `documentAccess: dynamic-page` is required for new plugins  
- Avoid `localStorage` in `ui.html` (data: UI) — use `figma.clientStorage`  
- Keep **Import sample** so reviewers can verify without Clonyfy  
