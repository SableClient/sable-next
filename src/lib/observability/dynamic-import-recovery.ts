const RELOAD_KEY = 'sable:dynamic-import-reload';
const RELOAD_WINDOW_MS = 30_000;

export function recoverStaleDynamicImport(error: unknown): boolean {
  if (
    !(error instanceof Error) ||
    !/(?:failed to fetch|error loading) dynamically imported module/i.test(error.message)
  ) {
    return false;
  }

  try {
    const now = Date.now();
    const reloadedAt = Number(sessionStorage.getItem(RELOAD_KEY));
    if (Number.isFinite(reloadedAt) && now - reloadedAt < RELOAD_WINDOW_MS) return false;

    sessionStorage.setItem(RELOAD_KEY, String(now));
    location.reload();
    return true;
  } catch {
    return false;
  }
}

export function installDynamicImportRecovery(): () => void {
  const handleRejection = (event: Event): void => {
    const reason: unknown = (event as PromiseRejectionEvent).reason;
    if (!recoverStaleDynamicImport(reason)) return;
    event.preventDefault();
  };

  window.addEventListener('unhandledrejection', handleRejection);
  return () => {
    window.removeEventListener('unhandledrejection', handleRejection);
  };
}
