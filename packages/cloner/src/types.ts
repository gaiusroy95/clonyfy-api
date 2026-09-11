export interface ClonerOptions {
  url: string;
  out: string;
  maxPages: number;
  depth: number;
  ignoreRobots: boolean;
  concurrency: number;
  verbose?: boolean;
  /** Scale "Select all pages": same-origin crawl with high page/depth budget. */
  fullSite?: boolean;
}

export interface ArtifactWrittenEvent {
  relPath: string;
  absPath: string;
  kind: 'page' | 'route-map' | 'manifest' | 'asset';
}

export interface NetworkEntry {
  method: string;
  url: string;
  postData: string | null;
  status: number;
  contentType: string;
  body: string | null;
}

export interface AssetEntry {
  originalUrl: string;
  localPath: string;  // relative to generated public dir
}

export interface PageRecord {
  url: string;
  route: string;   // pathname e.g. "/about"
  html: string;    // rewritten HTML
  assets: AssetEntry[];
  network: NetworkEntry[];
  failedAssets?: string[]; // URLs that could not be saved locally
  /** Per-URL failure reason: budget | http_status | timeout | too_large | error */
  failedAssetReasons?: Record<string, string>;
}

export interface Manifest {
  targetOrigin: string;
  capturedAt: string;
  pages: PageRecord[];
}

export interface ApiRouteSpec {
  method: string;
  path: string;       // Next.js style e.g. /api/users/[id]
  fixtureKey: string; // filesystem-safe key
  sampleRequest: Record<string, unknown> | null;
  responses: Array<{ status: number; contentType: string; body: unknown }>;
  looksLikeForm: boolean;
  inferredFields: string[];
  isGraphQL?: boolean;
  graphQLOperation?: string;
}
