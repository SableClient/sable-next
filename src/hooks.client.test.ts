// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';
import { preferences } from '#lib/settings/preferences.svelte.js';
import * as Sentry from '@sentry/sveltekit';

vi.mock('@sentry/sveltekit', () => ({
  captureException: vi.fn(),
  consoleLoggingIntegration: vi.fn(),
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
  preferences.errorReporting = false;
  vi.unstubAllEnvs();
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

test('fully samples call traces and inherits sampling for every other trace', async () => {
  preferences.errorReporting = true;
  vi.stubEnv('VITE_SENTRY_DSN', 'https://public@example.invalid/1');

  await import('./hooks.client.js');

  const options = vi.mocked(Sentry.init).mock.calls[0][0];
  const inheritOrSampleWith = vi.fn(() => 0.42);
  expect(options.tracesSampler?.({ name: 'call.join', inheritOrSampleWith })).toBe(1);
  expect(options.tracesSampler?.({ name: 'navigation', inheritOrSampleWith })).toBe(0.42);
  expect(inheritOrSampleWith).toHaveBeenCalledWith(0.1);
});
