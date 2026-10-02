// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';
import * as Sentry from '@sentry/sveltekit';
import { preferences } from '#lib/settings/preferences.svelte.js';

const state = vi.hoisted(() => ({ envelopes: [] as unknown[] }));

vi.mock('@sentry/sveltekit', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const sdk = (await import(
    require.resolve('@sentry/browser', { paths: [require.resolve('@sentry/sveltekit')] })
  )) as typeof import('@sentry/sveltekit');
  return {
    ...sdk,
    init: (options: unknown) =>
      sdk.init({
        ...(options as object),
        transport: () => ({
          send: (envelope: unknown) => {
            state.envelopes.push(envelope);
            return Promise.resolve({});
          },
          flush: () => Promise.resolve(true),
        }),
      }),
  };
});
vi.mock('#lib/platform/telemetry.js', () => ({ syncTelemetryConsent: vi.fn() }));
vi.mock('#lib/settings/preferences.svelte.js', () => ({ preferences: { errorReporting: true } }));
vi.mock('#src/transport', () => ({ CoreError: class CoreError extends Error {} }));
vi.mock('./worker/core.worker.ts?sharedworker&url', () => ({ default: 'core.worker.js' }));
vi.mock('#src/generated/wasm/sable_wasm_version.js', () => ({ default: 'test-wasm-version' }));
vi.mock('#lib/migrations/v1/migration.js', () => ({ migrateV1: vi.fn() }));

afterEach(async () => {
  await Sentry.close(0);
  state.envelopes.length = 0;
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.resetModules();
});

async function boot() {
  preferences.errorReporting = true;
  vi.stubEnv('VITE_SENTRY_DSN', 'https://public@example.invalid/1');
  return import('./hooks.client');
}

function errorEvents() {
  return (state.envelopes as [unknown, [{ type: string }, unknown][]][]).flatMap(([, items]) =>
    items.filter(([header]) => header.type === 'event').map(([, event]) => event)
  );
}

test('reports console errors with redacted arguments', async () => {
  await boot();
  console.error(
    'attachment failed https://hs.example/rooms/%21private%3Aexample.org/messages',
    new Error('token=secret !private:example.org')
  );
  await Sentry.flush(0);
  expect(errorEvents()).toHaveLength(1);
  const sent = JSON.stringify(errorEvents());
  expect(sent).toContain('auto.core.capture_console');
  expect(sent).not.toContain('secret');
  expect(sent).not.toContain('!private:example.org');
  expect(sent).not.toContain('private');
});

test('reports SvelteKit errors once as unhandled', async () => {
  const { handleError } = await boot();
  const result = handleError({
    kind: 'unknown',
    error: new Error('render failure'),
    event: {} as Parameters<typeof handleError>[0]['event'],
  });
  await Sentry.flush(0);
  expect(errorEvents()).toHaveLength(1);
  expect(JSON.stringify(errorEvents())).toContain('auto.function.sveltekit.handle_error');
  expect(JSON.stringify(errorEvents())).toContain('"handled":false');
  expect(result).toHaveProperty('eventId');
});

test('keeps console reporting after disabling debug logging', async () => {
  const { setDebugLogging } = await import('#lib/observability/debug-log.svelte.js');
  setDebugLogging(true);
  try {
    await boot();
    setDebugLogging(false);
    console.error('failure after developer logging is disabled');
    await Sentry.flush(0);
    expect(errorEvents()).toHaveLength(1);
  } finally {
    setDebugLogging(false);
  }
});

test('reports worker panics once with their fingerprint', async () => {
  await boot();
  const port = {
    onmessage: null as ((event: MessageEvent) => void) | null,
    postMessage: vi.fn(),
    close: vi.fn(),
    start: vi.fn(),
  };
  vi.stubGlobal(
    'SharedWorker',
    class extends EventTarget {
      port = port;
    }
  );
  const { createWebTransport } = await import('./transport/web');
  const transport = createWebTransport();
  const restored = transport.send({ type: 'restore' }).catch(() => undefined);
  port.onmessage?.({
    data: { panic: { message: 'worker error: Uncaught RangeError' } },
  } as MessageEvent);
  await Sentry.flush(0);
  expect(errorEvents()).toHaveLength(1);
  expect(errorEvents()[0]).toMatchObject({
    fingerprint: ['wasm-core-crash', 'worker error: Uncaught RangeError'],
    tags: { source: 'wasm-core' },
  });
  transport.close();
  await restored;
});
