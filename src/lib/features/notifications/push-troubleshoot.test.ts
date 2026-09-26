import { expect, test } from 'vitest';

import type { RegisteredPusherView } from '#src/generated/protocol';

import type { PushHistoryEntry } from './push-history';
import {
  type TroubleshootCheck,
  type TroubleshootDeps,
  type TroubleshootResult,
  troubleshoot,
} from './push-troubleshoot';

type Results = Partial<Record<TroubleshootCheck, TroubleshootResult>>;

const gatewayPusher: RegisteredPusherView = {
  pushkey: 'key',
  app_id: 'moe.sable',
  kind: 'http',
  device_display_name: 'Browser',
  activated: null,
  gateway: 'https://push.example/_matrix/push/v1/notify',
};

function deps(overrides: Partial<TroubleshootDeps> = {}): TroubleshootDeps {
  let polls = 0;
  return {
    platform: 'web',
    webPushSupported: true,
    permissionGranted: () => Promise.resolve(true),
    alertsEnabled: () => true,
    nativeTransport: () => Promise.resolve(null),
    ownPushkey: () => Promise.resolve('key'),
    pushers: () => Promise.resolve([gatewayPusher]),
    pingGateway: () => Promise.resolve(true),
    sendDiagnostic: () =>
      Promise.resolve({ kind: 'sent', event_id: '$sable-diagnostic-1', accepted: true }),
    history: () => {
      polls += 1;
      const arrived: PushHistoryEntry[] =
        polls > 1
          ? [{ at: 1, outcome: 'DIAGNOSTIC_RECEIVED', eventId: '$sable-diagnostic-1' }]
          : [];
      return Promise.resolve(arrived);
    },
    wait: () => Promise.resolve(),
    ...overrides,
  };
}

async function run(options: TroubleshootDeps): Promise<Results> {
  const results: Results = {};
  for await (const result of troubleshoot(options)) results[result.check] = result;
  return results;
}

function states(results: Results): Record<string, string> {
  return Object.fromEntries(
    Object.entries(results).map(([check, result]) => [check, result.state])
  );
}

test('a working browser passes every check, the loopback included', async () => {
  const results = await run(deps());

  expect(states(results)).toEqual({
    permission: 'pass',
    alerts: 'pass',
    transport: 'pass',
    pusher: 'pass',
    gateway: 'pass',
    loopback: 'pass',
  });
  expect(results.gateway?.params).toEqual({ host: 'push.example' });
});

test('the desktop app has no push to check', async () => {
  expect(states(await run(deps({ platform: 'desktop' })))).toEqual({
    permission: 'pass',
    alerts: 'pass',
    transport: 'skip',
    pusher: 'skip',
    gateway: 'skip',
    loopback: 'skip',
  });
});

test('a device the homeserver has no pusher for stops at the pusher', async () => {
  const results = await run(deps({ pushers: () => Promise.resolve([]) }));

  expect(results.pusher?.message).toBe('settings.troubleshootPusherMissing');
  expect(results.gateway?.state).toBe('skip');
  expect(results.loopback?.state).toBe('skip');
});

test('a homeserver that delivers web push itself has no gateway to test', async () => {
  const results = await run(
    deps({
      pushers: () => Promise.resolve([{ ...gatewayPusher, gateway: null, activated: true }]),
      sendDiagnostic: () => Promise.resolve({ kind: 'no_gateway' }),
    })
  );

  expect(results.pusher?.message).toBe('settings.troubleshootPusherHomeserver');
  expect(results.gateway?.state).toBe('skip');
  expect(results.loopback?.message).toBe('settings.troubleshootLoopbackHomeserver');
});

test('a dormant MSC4174 pusher fails the pusher check', async () => {
  const results = await run(
    deps({
      pushers: () => Promise.resolve([{ ...gatewayPusher, gateway: null, activated: false }]),
    })
  );

  expect(results.pusher?.message).toBe('settings.troubleshootPusherInactive');
});

test('a pushkey the gateway rejects fails the loopback', async () => {
  const results = await run(deps({ sendDiagnostic: () => Promise.resolve({ kind: 'rejected' }) }));

  expect(results.loopback?.message).toBe('settings.troubleshootLoopbackRejected');
});

test('a gateway a browser cannot read from is a warning, not a failure', async () => {
  const results = await run(deps({ pingGateway: () => Promise.resolve(null) }));

  expect(results.gateway?.state).toBe('warn');
});

test('a diagnostic push that never lands fails once the wait runs out', async () => {
  let waits = 0;
  const results = await run(
    deps({
      history: () => Promise.resolve([]),
      wait: () => {
        waits += 1;
        return Promise.resolve();
      },
    })
  );

  expect(results.loopback?.message).toBe('settings.troubleshootLoopbackMissing');
  expect(waits).toBeGreaterThan(0);
});

test('an Android device reports its distributor', async () => {
  const results = await run(
    deps({
      platform: 'android',
      nativeTransport: () =>
        Promise.resolve({ provider: 'unifiedpush', distributor: 'io.heckel.ntfy' }),
    })
  );

  expect(results.transport?.params).toEqual({
    provider: 'unifiedpush',
    distributor: 'io.heckel.ntfy',
  });
});
