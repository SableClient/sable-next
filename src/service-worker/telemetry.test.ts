import { afterEach, expect, test, vi } from 'vitest';

const state = vi.hoisted(() => ({ consent: vi.fn(), envelopes: [] as unknown[] }));

vi.mock('#lib/features/notifications/room-names.js', () => ({ telemetryConsent: state.consent }));
vi.mock('@sentry/sveltekit', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const sdk = (await import(
    require.resolve('@sentry/browser', { paths: [require.resolve('@sentry/sveltekit')] })
  )) as typeof import('@sentry/sveltekit');
  return {
    ...sdk,
    makeFetchTransport: () => ({
      send: (envelope: unknown) => {
        state.envelopes.push(envelope);
        return Promise.resolve({});
      },
      flush: () => Promise.resolve(true),
    }),
  };
});

afterEach(() => {
  state.envelopes.length = 0;
  state.consent.mockReset();
  vi.unstubAllEnvs();
  vi.resetModules();
});

test('reports push failures with redacted identifiers', async () => {
  vi.stubEnv('VITE_SENTRY_DSN', 'https://public@example.invalid/1');
  state.consent.mockResolvedValue(true);
  const { watchWorkerOperation } = await import('./telemetry');
  const error = new Error('push failed for !private:example.org token=secret');
  await expect(watchWorkerOperation('push', Promise.reject(error))).rejects.toBe(error);

  const sent = JSON.stringify(state.envelopes);
  expect(sent).toContain('service-worker');
  expect(sent).toContain('push failed');
  expect(sent).not.toContain('!private:example.org');
  expect(sent).not.toContain('secret');
});

test('requires consent and a DSN', async () => {
  state.consent.mockResolvedValue(false);
  const { reportWorkerError } = await import('./telemetry');
  await reportWorkerError('push', new Error('failure'));
  vi.stubEnv('VITE_SENTRY_DSN', 'https://public@example.invalid/1');
  await reportWorkerError('push', new Error('failure'));
  expect(state.envelopes).toEqual([]);
});

test('drops events after consent is revoked', async () => {
  vi.stubEnv('VITE_SENTRY_DSN', 'https://public@example.invalid/1');
  state.consent.mockResolvedValueOnce(true).mockResolvedValue(false);
  const { reportWorkerError } = await import('./telemetry');
  await reportWorkerError('push', new Error('failure'));
  expect(state.consent).toHaveBeenCalledTimes(2);
  expect(state.envelopes).toEqual([]);
});
