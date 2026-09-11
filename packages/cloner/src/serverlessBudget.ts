export function isServerlessRuntime(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): boolean {
  return env.VERCEL === '1'
    || env.VERCEL === 'true'
    || env.CLONYFY_SERVERLESS === '1'
    || env.CLONYFY_SERVERLESS === 'true'
    || !!env.VERCEL_ENV
    || !!env.AWS_LAMBDA_FUNCTION_NAME
    || !!env.LAMBDA_TASK_ROOT
    || cwd.startsWith('/var/task');
}

/**
 * Clonyfy product goal: near-identical visual clones.
 * Default ON. Set CLONYFY_QUALITY=0 only for emergency low-cost / low-RAM runs.
 */
export function isQualityCloneProfile(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  if (env.CLONYFY_QUALITY === '0' || env.CLONYFY_QUALITY === 'false') return false;
  return true;
}

/**
 * Fast capture budgets (shorter waits, smaller asset caps).
 * Explicit CLONYFY_FAST_CLONE=1 forces fast.
 * Quality mode (default) disables auto-fast so hosted clones keep desktop fidelity.
 */
export function isFastCloneProfile(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): boolean {
  if (env.CLONYFY_FAST_CLONE === '0' || env.CLONYFY_FAST_CLONE === 'false') return false;
  if (env.CLONYFY_FAST_CLONE === '1' || env.CLONYFY_FAST_CLONE === 'true') return true;
  if (isQualityCloneProfile(env)) return false;
  if (isServerlessRuntime(env, cwd)) return true;
  if (env.RENDER || env.RENDER_EXTERNAL_URL) return true;
  if (env.CLONYFY_HOSTED === '1' || env.CLONYFY_HOSTED === 'true') return true;
  return false;
}

export const IS_SERVERLESS = isServerlessRuntime();
export const IS_QUALITY = isQualityCloneProfile();
export const IS_FAST_CLONE = isFastCloneProfile();

/** Shared /tmp budget for downloaded assets (Chromium + HTML also use /tmp on Vercel). */
export const SERVERLESS_ASSET_BUDGET_BYTES = (IS_SERVERLESS ? (IS_QUALITY ? 220 : 140) : Infinity) * 1024 * 1024;
/** Keep headroom so CSS/fonts are not starved by large videos/images. */
const PRIORITY_RESERVE_BYTES = IS_SERVERLESS ? (IS_QUALITY ? 40 : 22) * 1024 * 1024 : 0;

let assetBytesWritten = 0;

export function resetServerlessAssetBudget(): void {
  assetBytesWritten = 0;
}

export function serverlessAssetBudgetUsed(): number {
  return assetBytesWritten;
}

/** Returns false when the write would exceed the serverless asset budget. */
export function reserveServerlessAssetBytes(
  size: number,
  opts: { priority?: boolean } = {},
): boolean {
  if (!IS_SERVERLESS) return true;
  if (size <= 0) return true;
  const priority = !!opts.priority;
  const hardLimit = SERVERLESS_ASSET_BUDGET_BYTES;
  if (assetBytesWritten + size > hardLimit) return false;
  if (!priority) {
    const softLimit = Math.max(hardLimit - PRIORITY_RESERVE_BYTES, hardLimit * 0.8);
    if (assetBytesWritten + size > softLimit && size > 400_000) return false;
  }
  assetBytesWritten += size;
  return true;
}
