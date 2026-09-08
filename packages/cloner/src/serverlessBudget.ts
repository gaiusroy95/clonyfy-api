export function isServerlessRuntime(
  env: NodeJS.ProcessEnv = process.env,
  cwd = process.cwd(),
): boolean {
  return env.VERCEL === '1'
    || env.VERCEL === 'true'
    || env.CLONYFY_SERVERLESS === '1'
    || !!env.VERCEL_ENV
    || !!env.AWS_LAMBDA_FUNCTION_NAME
    || !!env.LAMBDA_TASK_ROOT
    || cwd.startsWith('/var/task');
}

export const IS_SERVERLESS = isServerlessRuntime();

/** Shared /tmp budget for downloaded assets (Chromium + HTML also use /tmp on Vercel). */
export const SERVERLESS_ASSET_BUDGET_BYTES = (IS_SERVERLESS ? 100 : Infinity) * 1024 * 1024;

let assetBytesWritten = 0;

export function resetServerlessAssetBudget(): void {
  assetBytesWritten = 0;
}

export function serverlessAssetBudgetUsed(): number {
  return assetBytesWritten;
}

/** Returns false when the write would exceed the serverless asset budget. */
export function reserveServerlessAssetBytes(size: number): boolean {
  if (!IS_SERVERLESS) return true;
  if (size <= 0) return true;
  if (assetBytesWritten + size > SERVERLESS_ASSET_BUDGET_BYTES) return false;
  assetBytesWritten += size;
  return true;
}
