import { describe, it, expect } from 'vitest';
import { analyzeTraffic } from '../analyzer.js';
import type { NetworkEntry } from '../types.js';

const ORIGIN = 'https://example.com';

function entry(overrides: Partial<NetworkEntry> = {}): NetworkEntry {
  return {
    method: 'GET',
    url: `${ORIGIN}/api/data`,
    postData: null,
    status: 200,
    contentType: 'application/json',
    body: '{}',
    ...overrides,
  };
}

describe('analyzeTraffic', () => {
  it('returns empty array for no entries', () => {
    expect(analyzeTraffic([], ORIGIN)).toEqual([]);
  });

  it('filters out static asset requests', () => {
    const entries: NetworkEntry[] = [
      entry({ url: `${ORIGIN}/styles.css` }),
      entry({ url: `${ORIGIN}/bundle.js` }),
      entry({ url: `${ORIGIN}/logo.png` }),
      entry({ url: `${ORIGIN}/font.woff2` }),
    ];
    expect(analyzeTraffic(entries, ORIGIN)).toHaveLength(0);
  });

  it('filters out HTML navigation responses', () => {
    const entries: NetworkEntry[] = [
      entry({ method: 'GET', url: `${ORIGIN}/about`, contentType: 'text/html' }),
    ];
    expect(analyzeTraffic(entries, ORIGIN)).toHaveLength(0);
  });

  it('filters out synthetic CONSOLE_ERROR entries', () => {
    const entries: NetworkEntry[] = [
      entry({ method: 'CONSOLE_ERROR', url: `${ORIGIN}/api/data` }),
    ];
    expect(analyzeTraffic(entries, ORIGIN)).toHaveLength(0);
  });

  it('filters out cross-origin non-GraphQL entries', () => {
    const entries: NetworkEntry[] = [
      entry({ url: 'https://cdn.other.com/api/stuff' }),
    ];
    expect(analyzeTraffic(entries, ORIGIN)).toHaveLength(0);
  });

  it('keeps cross-origin GraphQL endpoints', () => {
    const entries: NetworkEntry[] = [
      entry({ method: 'POST', url: 'https://api.other.com/graphql', contentType: 'application/json' }),
    ];
    const result = analyzeTraffic(entries, ORIGIN);
    expect(result).toHaveLength(1);
    expect(result[0].isGraphQL).toBe(true);
  });

  it('keeps same-origin JSON API requests', () => {
    const entries: NetworkEntry[] = [
      entry({ url: `${ORIGIN}/api/users`, contentType: 'application/json' }),
    ];
    const result = analyzeTraffic(entries, ORIGIN);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('/api/users');
  });

  it('normalizes numeric path segments to [id]', () => {
    const entries: NetworkEntry[] = [
      entry({ url: `${ORIGIN}/api/users/12345` }),
    ];
    const result = analyzeTraffic(entries, ORIGIN);
    expect(result[0].path).toBe('/api/users/[id]');
  });

  it('normalizes UUID path segments to [id]', () => {
    const entries: NetworkEntry[] = [
      entry({ url: `${ORIGIN}/api/posts/550e8400-e29b-41d4-a716-446655440000` }),
    ];
    const result = analyzeTraffic(entries, ORIGIN);
    expect(result[0].path).toBe('/api/posts/[id]');
  });

  it('does not normalize short segments', () => {
    const entries: NetworkEntry[] = [
      entry({ url: `${ORIGIN}/api/v2/users` }),
    ];
    const result = analyzeTraffic(entries, ORIGIN);
    expect(result[0].path).toBe('/api/v2/users');
  });

  it('groups duplicate (method, path) pairs into one spec', () => {
    // IDs must be length > 3 to trigger normalization (short IDs like "1" are kept as-is)
    const entries: NetworkEntry[] = [
      entry({ url: `${ORIGIN}/api/users/10001` }),
      entry({ url: `${ORIGIN}/api/users/10002` }),
      entry({ url: `${ORIGIN}/api/users/10003` }),
    ];
    const result = analyzeTraffic(entries, ORIGIN);
    expect(result).toHaveLength(1);
    expect(result[0].path).toBe('/api/users/[id]');
  });

  it('treats different HTTP methods as separate specs', () => {
    const entries: NetworkEntry[] = [
      entry({ method: 'GET', url: `${ORIGIN}/api/users` }),
      entry({ method: 'POST', url: `${ORIGIN}/api/users`, postData: '{"name":"test"}' }),
    ];
    const result = analyzeTraffic(entries, ORIGIN);
    expect(result).toHaveLength(2);
  });

  it('detects form submissions (POST with postData, not graphql/auth)', () => {
    const entries: NetworkEntry[] = [
      entry({ method: 'POST', url: `${ORIGIN}/api/contact`, postData: 'name=Alice&email=alice@example.com', contentType: 'application/x-www-form-urlencoded' }),
    ];
    const result = analyzeTraffic(entries, ORIGIN);
    expect(result[0].looksLikeForm).toBe(true);
  });

  it('does not mark auth endpoints as form submissions', () => {
    const entries: NetworkEntry[] = [
      entry({ method: 'POST', url: `${ORIGIN}/api/auth/login`, postData: '{"email":"a@b.com"}' }),
    ];
    const result = analyzeTraffic(entries, ORIGIN);
    expect(result[0].looksLikeForm).toBe(false);
  });

  it('infers fields from JSON postData', () => {
    const entries: NetworkEntry[] = [
      entry({ method: 'POST', url: `${ORIGIN}/api/contact`, postData: '{"name":"Alice","email":"alice@x.com","message":"hello"}' }),
    ];
    const result = analyzeTraffic(entries, ORIGIN);
    expect(result[0].inferredFields).toEqual(['name', 'email', 'message']);
  });

  it('infers fields from URL-encoded postData', () => {
    const entries: NetworkEntry[] = [
      entry({ method: 'POST', url: `${ORIGIN}/api/signup`, postData: 'username=foo&password=bar' }),
    ];
    const result = analyzeTraffic(entries, ORIGIN);
    expect(result[0].inferredFields).toEqual(['username', 'password']);
  });

  it('detects and parses GraphQL operation name', () => {
    const gqlBody = JSON.stringify({
      query: 'query GetUser($id: ID!) { user(id: $id) { name } }',
      variables: { id: '123' },
    });
    const entries: NetworkEntry[] = [
      entry({ method: 'POST', url: `${ORIGIN}/graphql`, postData: gqlBody }),
    ];
    const result = analyzeTraffic(entries, ORIGIN);
    expect(result[0].isGraphQL).toBe(true);
    expect(result[0].graphQLOperation).toBe('query GetUser');
  });

  it('generates a stable fixtureKey', () => {
    const entries: NetworkEntry[] = [
      entry({ method: 'GET', url: `${ORIGIN}/api/users` }),
    ];
    const result = analyzeTraffic(entries, ORIGIN);
    expect(result[0].fixtureKey).toBe('GET_api_users');
  });

  it('filters analytics/tracker URLs', () => {
    const entries: NetworkEntry[] = [
      entry({ url: 'https://www.googletagmanager.com/gtag/js' }),
      entry({ url: `${ORIGIN}/analytics/track` }),
      entry({ url: 'https://cdn.segment.io/analytics.js' }),
    ];
    expect(analyzeTraffic(entries, ORIGIN)).toHaveLength(0);
  });

  it('collects multiple response statuses for the same route', () => {
    // Same URL, different responses — simulates the same endpoint returning different statuses
    const entries: NetworkEntry[] = [
      entry({ url: `${ORIGIN}/api/items`, status: 200 }),
      entry({ url: `${ORIGIN}/api/items`, status: 404 }),
    ];
    const result = analyzeTraffic(entries, ORIGIN);
    expect(result).toHaveLength(1);
    expect(result[0].responses.map((r) => r.status).sort()).toEqual([200, 404]);
  });
});
