import { updated } from '$app/state';

import { ModelAssetError } from '#lib/model/model.js';

const RELOAD_KEY = 'sable:dynamic-import-reload';
const RELOAD_WINDOW_MS = 30_000;

function isStaleAssetError(error: unknown): boolean {
  return (
    error instanceof ModelAssetError ||
    (error instanceof Error &&
      /(?:failed to fetch|error loading) dynamically imported module|importing a module script failed|unable to preload CSS for/i.test(
        error.message
      ))
  );
}

let reloading = false;

export function isReloadingForNewBuild(error: unknown): boolean {
  return reloading && isStaleAssetError(error);
}

/**
 * Reloads only when the failed asset comes from a build the server has
 * replaced. A failure on an unchanged build is a network problem and a reload
 * would not fix it, so the error is left to surface instead.
 */
export async function recoverStaleAsset(error: unknown): Promise<boolean> {
  if (!isStaleAssetError(error)) return false;

  try {
    const now = Date.now();
    const reloadedAt = Number(sessionStorage.getItem(RELOAD_KEY));
    if (Number.isFinite(reloadedAt) && now - reloadedAt < RELOAD_WINDOW_MS) return false;
    if (!(await updated.check())) return false;

    sessionStorage.setItem(RELOAD_KEY, String(now));
    reloading = true;
    location.reload();
    return true;
  } catch {
    return false;
  }
}

export function installDynamicImportRecovery(): () => void {
  const handleRejection = (event: Event): void => {
    void recoverStaleAsset((event as PromiseRejectionEvent).reason);
  };

  window.addEventListener('unhandledrejection', handleRejection);
  return () => {
    window.removeEventListener('unhandledrejection', handleRejection);
  };
}
