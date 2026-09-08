// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';

vi.mock('@sentry/sveltekit', () => ({
  captureException: vi.fn(),
  init: vi.fn(),
}));
vi.mock('#lib/platform/telemetry.js', () => ({
  syncNativeTelemetryConsent: vi.fn(),
}));
vi.mock('#lib/settings/preferences.svelte.js', () => ({
  preferences: { errorReporting: false },
}));
vi.mock('#src/transport', () => ({
  CoreError: class CoreError extends Error {},
}));

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
  vi.restoreAllMocks();
  vi.resetModules();
});

test('recovers a global stale-import rejection that never reaches handleError', async () => {
  const reload = vi.fn();
  vi.stubGlobal('location', { reload });
  vi.spyOn(Date, 'now').mockReturnValue(1_000_000);

  await import('./hooks.client.js');
  const event = Object.assign(new Event('unhandledrejection', { cancelable: true }), {
    reason: new Error('Failed to fetch dynamically imported module'),
  });

  window.dispatchEvent(event);

  expect(reload).toHaveBeenCalledOnce();
  expect(event.defaultPrevented).toBe(true);
});
