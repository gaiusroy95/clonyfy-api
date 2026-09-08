import type { NetworkEntry, ApiRouteSpec } from './types.js';

const HTTP_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);

const SKIP_PATTERNS = [
  /\.(css|js|mjs|png|jpg|jpeg|gif|svg|webp|ico|woff|woff2|ttf|eot|otf|avif|map|html|htm)(\?|$)/i,
  /^(data:|blob:)/,
  /\/_next\//,
  /\/static\//,
  /\/favicon/,
  /__webpack/,
  // CDN/analytics endpoints — not real application API routes
  /\/cdn-cgi\//,
  /\/analytics/,
  /\/gtag\//,
  /hotjar/,
  /mixpanel/,
  /segment\.io/,
  /sentry\.io/,
];

const DYNAMIC_SEGMENT = /^([0-9a-f]{8,}|[0-9]+|[0-9a-f-]{36})$/i;

function normalizePath(pathname: string): string {
  return pathname
    .split('/')
    .map((seg) => (DYNAMIC_SEGMENT.test(seg) && seg.length > 3 ? '[id]' : seg))
    .join('/');
}

function fixtureKey(method: string, path: string): string {
  return `${method.toUpperCase()}_${path.replace(/^\//, '').replace(/\//g, '_').replace(/\[|\]/g, '') || 'root'}`;
}

function inferFieldsFromBody(raw: string | null): string[] {
  if (!raw) return [];
  try {
    const obj = JSON.parse(raw);
    if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
      return Object.keys(obj).slice(0, 20);
    }
  } catch { /* not JSON */ }
  // try URL-encoded form
  try {
    return [...new URLSearchParams(raw).keys()];
  } catch { return []; }
}

function looksLikeForm(entries: NetworkEntry[]): boolean {
  // Check any entry in the group — the first might have no postData even if others do.
  return entries.some((e) =>
    e.method === 'POST' &&
    !!e.postData &&
    !e.url.includes('/graphql') &&
    !e.url.includes('/gql') &&
    !e.url.includes('/api/auth'),
  );
}

function isGraphQL(entry: NetworkEntry): boolean {
  const u = entry.url.toLowerCase();
  return u.includes('/graphql') || u.includes('/gql');
}

function inferGraphQLOperation(postData: string | null): { operation: string | null; variables: Record<string, unknown> | null } {
  if (!postData) return { operation: null, variables: null };
  try {
    const body = JSON.parse(postData);
    const query: string = body.query || '';
    const match = query.match(/^\s*(query|mutation|subscription)\s+(\w+)/);
    const operation = match ? `${match[1]} ${match[2]}` : (body.operationName || null);
    const variables = body.variables && typeof body.variables === 'object' ? body.variables : null;
    return { operation, variables };
  } catch { return { operation: null, variables: null }; }
}

export function analyzeTraffic(entries: NetworkEntry[], targetOrigin: string): ApiRouteSpec[] {
  const filtered = entries.filter((e) => {
    // Drop synthetic methods like CONSOLE_ERROR — only real HTTP methods allowed
    if (!HTTP_METHODS.has(e.method.toUpperCase())) return false;
    // Drop GET HTML pages (navigations, not API calls). Keep non-GET HTML-ish form
    // responses because old backends often submit to .php/.asp endpoints.
    if (e.method.toUpperCase() === 'GET' && e.contentType?.includes('text/html')) return false;
    if (e.method.toUpperCase() === 'GET' && (
      e.contentType?.includes('text/css') ||
      e.contentType?.includes('javascript') ||
      e.contentType?.startsWith('image/') ||
      e.contentType?.startsWith('font/')
    )) return false;
    if (SKIP_PATTERNS.some((p) => p.test(e.url))) return false;
    try {
      const u = new URL(e.url);
      // Include same-origin AND cross-origin GraphQL endpoints
      if (u.origin === targetOrigin) return true;
      if (u.pathname.includes('/graphql') || u.pathname.includes('/gql')) return true;
      return false;
    } catch { return false; }
  });

  // Group by (method, normalizedPath)
  const groups = new Map<string, NetworkEntry[]>();
  for (const entry of filtered) {
    try {
      const u = new URL(entry.url);
      const normalized = normalizePath(u.pathname);
      const key = `${entry.method.toUpperCase()}:${normalized}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(entry);
    } catch { /* skip */ }
  }

  const specs: ApiRouteSpec[] = [];
  for (const [key, group] of groups) {
    const colonIdx = key.indexOf(':');
    const method = key.slice(0, colonIdx);
    const path = key.slice(colonIdx + 1);
    const first = group[0];
    const responses = [...new Map(
      group.map((e) => [e.status, { status: e.status, contentType: e.contentType, body: tryParseJson(e.body, e.contentType) }])
    ).values()];
    const bodyEntry = group.find((e) => e.postData) ?? first;
    const inferredFields = inferFieldsFromBody(bodyEntry.postData);
    const sampleRequest = inferredFields.length
      ? Object.fromEntries(inferredFields.map((f) => [f, '']))
      : null;

    const gql = isGraphQL(first) ? inferGraphQLOperation(first.postData) : null;
    const finalSampleRequest = gql?.variables
      ? { variables: gql.variables, operationName: gql.operation }
      : sampleRequest;

    specs.push({
      method,
      path,
      fixtureKey: fixtureKey(method, path),
      sampleRequest: finalSampleRequest,
      responses,
      looksLikeForm: looksLikeForm(group),
      inferredFields: gql ? Object.keys(gql.variables || {}) : inferredFields,
      isGraphQL: !!gql,
      graphQLOperation: gql?.operation ?? undefined,
    });
  }

  return specs;
}

function tryParseJson(raw: string | null, contentType = ''): unknown {
  if (!raw) return null;
  if (!contentType.includes('json')) return raw;
  try { return JSON.parse(raw); } catch { return raw; }
}
