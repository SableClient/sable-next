import { invoke, isTauri } from '@tauri-apps/api/core';

import { preferences } from '#lib/settings/preferences.svelte.js';
import { putTelemetryConsent } from '#lib/features/notifications/room-names.js';

export function telemetryConsentPending(): boolean {
  return Boolean(import.meta.env.VITE_SENTRY_DSN) && !preferences.telemetryAsked;
}

export function syncTelemetryConsent(enabled: boolean): void {
  if (!isTauri()) {
    if (typeof indexedDB !== 'undefined') {
      void putTelemetryConsent(enabled && Boolean(import.meta.env.VITE_SENTRY_DSN)).catch(
        (error: unknown) => {
          console.warn('[sable] worker telemetry consent not applied', error);
        }
      );
    }
    return;
  }

  void invoke('set_native_sentry_enabled', { enabled }).catch((error: unknown) => {
    console.warn('[sable] native crash reporting consent not applied', error);
  });
}
