# Clonyfy Import (Figma plugin)

Turns Clonyfy **Scene Graph** exports into editable Figma layers (frames, fills, text, images, gradients, borders).

## For customers (production)

1. Install **Clonyfy Import** once from [Figma Community](https://www.figma.com/community) (search “Clonyfy Import”, or use the link shown in Clonyfy after publish).
2. In Clonyfy: **Export to Figma → Export for Figma Desktop** (copies JSON to the clipboard).
3. In Figma: **Plugins → Clonyfy Import** (or **Run last plugin** / `Ctrl+Alt+P`).
4. The plugin auto-imports from the clipboard.

No local `figma-plugin/` folder is required for customers.

Web-only alternative: **Download SVG for Figma Web** → drag onto the canvas.

## For developers (before Community approval)

1. Figma Desktop → **Plugins → Development → Import plugin from manifest…**
2. Select this folder’s `manifest.json`
3. Use **Import sample** to verify

See **[PUBLISH.md](./PUBLISH.md)** for the full Community publish checklist.

## Files

| File | Purpose |
|---|---|
| `manifest.json` | Plugin manifest (`id` must be replaced with Figma-generated ID before publish) |
| `code.js` | Main thread — builds layers |
| `ui.html` | Plugin UI — clipboard / sample / chunked transfer |
| `community-listing.md` | Copy for the Community listing |
| `assets/` | Icon + cover SVGs (export to PNG for the publish modal) |

## Notes

- Plugin UI runs as a `data:` URL — do not use `localStorage` (use `figma.clientStorage`).
- `documentAccess: dynamic-page` is required for new plugins.
- Network access is unrestricted so IMAGE layers can fetch cloned-site / CDN URLs.
