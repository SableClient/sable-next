import { invoke, isTauri } from '@tauri-apps/api/core';

export function syncNativeTelemetryConsent(enabled: boolean): void {
  if (!isTauri()) return;

  void invoke('set_native_sentry_enabled', { enabled }).catch((error: unknown) => {
    console.warn('[sable] native crash reporting consent not applied', error);
  });
}
