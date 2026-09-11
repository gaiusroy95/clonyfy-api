/**
 * Vercel serverless entry — re-exports the shared HTTP handler from server.js.
 * Local/Render still use `node server.js` (createServer + listen).
 */
export { default } from '../server.js';
