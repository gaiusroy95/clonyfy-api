import { readFileSync, existsSync } from 'fs';
import { join } from 'path';

/**
 * Picks the best fixture file for an incoming request.
 * Used by generated API routes to replay captured responses.
 */
export function loadFixture(fixturesDir, routeKey, method, statusCode = 200) {
  const base = join(fixturesDir, routeKey.replace(/\//g, '_'));
  const candidates = [
    `${base}.${method.toUpperCase()}.${statusCode}.json`,
    `${base}.${method.toUpperCase()}.json`,
    `${base}.json`,
  ];
  for (const c of candidates) {
    if (existsSync(c)) return JSON.parse(readFileSync(c, 'utf8'));
  }
  return null;
}

export function matchFixture(fixturesDir, routeKey, method, body) {
  const data = loadFixture(fixturesDir, routeKey, method);
  return data;
}
