import { isTauri } from '@tauri-apps/api/core';

export function needsAndroidHistoryRoot(historyLength: number, historyStateIdx: unknown): boolean {
  return historyLength <= 1 && !historyStateIdx;
}

export function ensureAndroidHistoryRoot(homeHref: string): void {
  if (!isTauri()) return;
  if (
    !needsAndroidHistoryRoot(
      window.history.length,
      (window.history.state as { idx?: number } | null)?.idx
    )
  ) {
    return;
  }
  if (window.location.href === new URL(homeHref, window.location.href).href) return;

  const state = (window.history.state ?? {}) as { idx?: number };
  const currentHref = window.location.href;
  window.history.replaceState(state, '', homeHref);
  window.history.pushState({ ...state, idx: 1 }, '', currentHref);
}
