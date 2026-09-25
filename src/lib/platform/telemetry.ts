import { invoke, isTauri } from '@tauri-apps/api/core';

import { preferences } from '#lib/settings/preferences.svelte.js';

export function telemetryConsentPending(): boolean {
  return Boolean(import.meta.env.VITE_SENTRY_DSN) && !preferences.telemetryAsked;
}

export function syncNativeTelemetryConsent(enabled: boolean): void {
  if (!isTauri()) return;

  void invoke('set_native_sentry_enabled', { enabled }).catch((error: unknown) => {
    console.warn('[sable] native crash reporting consent not applied', error);
  });
}
