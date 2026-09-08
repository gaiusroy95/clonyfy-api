import { existsSync, mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';

export const PLACEHOLDER_IMAGE_WEB_PATH = '/_assets/__placeholder__.svg';
export const PLACEHOLDER_IMAGE_FILENAME = '__placeholder__.svg';

const PLACEHOLDER_SVG = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200" viewBox="0 0 320 200" role="img" aria-label="Image placeholder">
  <rect width="320" height="200" fill="#e8eaed"/>
  <rect x="1" y="1" width="318" height="198" fill="none" stroke="#c4c7cc" stroke-width="2" stroke-dasharray="8 6"/>
  <text x="160" y="108" text-anchor="middle" font-family="system-ui,-apple-system,Segoe UI,Roboto,Arial,sans-serif" font-size="22" fill="#5f6368">your pic</text>
</svg>`;

export const PLACEHOLDER_IMAGE_BODY = Buffer.from(PLACEHOLDER_SVG, 'utf8');

export const FALLBACK_FONT_CSS = `
html, body {
  font-family: system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
}
`.trim();

export function ensurePlaceholderAsset(assetsDir: string): void {
  const filePath = join(assetsDir, PLACEHOLDER_IMAGE_FILENAME);
  if (existsSync(filePath)) return;
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(filePath, PLACEHOLDER_SVG, 'utf8');
}
