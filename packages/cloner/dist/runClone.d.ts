interface ClonerOptions {
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
interface ArtifactWrittenEvent {
    relPath: string;
    absPath: string;
    kind: 'page' | 'route-map' | 'manifest' | 'asset';
}

interface CloneRunEvents {
    onLog?: (line: string) => void;
    onArtifactWritten?: (event: ArtifactWrittenEvent) => Promise<void>;
}
interface CloneRunResult {
    outDir: string;
    pages: number;
    assets: number;
    apiRoutes: number;
    logFile: string;
}
declare function runClone(options: ClonerOptions, events?: CloneRunEvents): Promise<CloneRunResult>;
/** Rebuild the Next.js project from persisted manifest + captured HTML (for exports after blob storage). */
declare function regenerateCloneProject(outDir: string): Promise<void>;

export { type CloneRunEvents, type CloneRunResult, regenerateCloneProject, runClone };
