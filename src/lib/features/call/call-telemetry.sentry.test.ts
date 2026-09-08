// @vitest-environment happy-dom

import { afterEach, expect, test } from 'vitest';
import { vi } from 'vitest';
import * as Sentry from '@sentry/sveltekit';

vi.mock('@sentry/sveltekit', async () => {
  const { createRequire } = await import('node:module');
  const require = createRequire(import.meta.url);
  const sdk: unknown = await import(
    require.resolve('@sentry/browser', { paths: [require.resolve('@sentry/sveltekit')] })
  );
  return sdk;
});
import { CallTelemetry } from './call-telemetry';

const envelopes: unknown[] = [];

afterEach(async () => {
  await Sentry.close(0);
  envelopes.length = 0;
});

test('sends sampled call traces without the transport secret', async () => {
  Sentry.init({
    dsn: 'https://public@example.invalid/1',
    defaultIntegrations: false,
    tracesSampler: ({ name }) => name.startsWith('call.') || name === 'call.join',
    transport: () => ({
      send: (envelope: unknown) => {
        envelopes.push(envelope);
        return Promise.resolve({});
      },
      flush: () => Promise.resolve(true),
    }),
  });

  const telemetry = new CallTelemetry({ 'call.camera_requested': false });
  await telemetry.step('call.signaling.join', () => Promise.resolve());
  telemetry.finish('connected');
  telemetry.event('call.transport.state', { 'call.connection': 'reconnecting' });
  telemetry.failure(
    'call.transport.connect',
    new Error('wss://sfu.example.org?token=super-secret')
  );
  await Sentry.flush(0);

  const sent = JSON.stringify(envelopes);
  expect(sent).toContain('call.join');
  expect(sent).toContain('call.signaling.join');
  expect(sent).toContain('call.transport.state');
  expect(sent).toContain('category":"call');
  expect(sent).toContain('call.failure');
  expect(sent).toContain('call.attempt_id');
  expect(sent).not.toContain('sfu.example.org');
  expect(sent).not.toContain('super-secret');
});
