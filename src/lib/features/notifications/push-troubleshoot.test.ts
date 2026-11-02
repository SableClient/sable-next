import { expect, test, vi } from 'vitest';

import type { RegisteredPusherView } from '#src/generated/protocol';

import type { PushHistoryEntry } from '#lib/notifications/push-history.js';
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
  endpoint: null,
};

function deps(overrides: Partial<TroubleshootDeps> = {}): TroubleshootDeps {
  let polls = 0;
  return {
    platform: 'web',
    webPushSupported: true,
    permissionGranted: () => Promise.resolve(true),
    alertsEnabled: () => true,
    nativeTransport: () => Promise.resolve(null),
    ignoringBatteryOptimizations: () => Promise.resolve(true),
    canScheduleExactAlarms: () => Promise.resolve(true),
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
    registrationFailure: () => null,
    reactivate: null,
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
    background: 'skip',
    alarms: 'skip',
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

test('an activated homeserver-delivered pusher reports the subscription host', async () => {
  const results = await run(
    deps({
      pushers: () =>
        Promise.resolve([
          {
            ...gatewayPusher,
            gateway: null,
            endpoint: 'https://push.example/sub/1',
            activated: true,
          },
        ]),
    })
  );

  expect(results.pusher?.message).toBe('settings.troubleshootPusherHomeserver');
  expect(results.gateway).toMatchObject({
    state: 'pass',
    message: 'settings.troubleshootGatewayActivated',
    params: { host: 'push.example' },
  });
  expect(results.loopback?.state).toBe('pass');
});

test('an unconfirmed homeserver-delivered pusher skips the gateway check', async () => {
  const results = await run(
    deps({
      pushers: () =>
        Promise.resolve([
          {
            ...gatewayPusher,
            gateway: null,
            endpoint: 'https://push.example/sub/1',
          },
        ]),
      sendDiagnostic: () => Promise.resolve({ kind: 'no_gateway' }),
    })
  );

  expect(results.gateway).toMatchObject({
    state: 'skip',
    message: 'settings.troubleshootGatewayHomeserver',
  });
});

test('a dormant MSC4174 pusher fails the pusher check', async () => {
  const results = await run(
    deps({
      pushers: () => Promise.resolve([{ ...gatewayPusher, gateway: null, activated: false }]),
    })
  );

  expect(results.pusher?.message).toBe('settings.troubleshootPusherInactive');
});

test('a dormant pusher is registered again and passes once the homeserver activates it', async () => {
  const dormant = { ...gatewayPusher, gateway: null, activated: false };
  let registered = false;
  let reads = 0;
  const results = await run(
    deps({
      pushers: () => {
        reads += 1;
        return Promise.resolve([{ ...dormant, activated: registered && reads > 2 }]);
      },
      reactivate: () => {
        registered = true;
        return Promise.resolve();
      },
      sendDiagnostic: () => Promise.resolve({ kind: 'no_gateway' }),
    })
  );

  expect(registered).toBe(true);
  expect(results.pusher?.state).toBe('pass');
  expect(results.pusher?.message).toBe('settings.troubleshootPusherHomeserver');
});

test('a pusher the homeserver never activates still fails after registering again', async () => {
  const reactivate = vi.fn(() => Promise.resolve());
  const results = await run(
    deps({
      pushers: () => Promise.resolve([{ ...gatewayPusher, gateway: null, activated: false }]),
      reactivate,
    })
  );

  expect(reactivate).toHaveBeenCalledOnce();
  expect(results.pusher?.message).toBe('settings.troubleshootPusherInactive');
  expect(results.gateway?.state).toBe('skip');
});

test('a pushkey the gateway rejects fails the loopback', async () => {
  const results = await run(deps({ sendDiagnostic: () => Promise.resolve({ kind: 'rejected' }) }));

  expect(results.loopback?.message).toBe('settings.troubleshootLoopbackRejected');
});

test('a push service that refuses direct tests skips the loopback', async () => {
  const results = await run(deps({ sendDiagnostic: () => Promise.resolve({ kind: 'refused' }) }));

  expect(results.loopback).toMatchObject({
    state: 'skip',
    message: 'settings.troubleshootLoopbackRefused',
  });
});

test('an MSC4174 diagnostic push waits for delivery', async () => {
  const results = await run(
    deps({
      pushers: () =>
        Promise.resolve([
          {
            ...gatewayPusher,
            gateway: null,
            endpoint: 'https://push.example/sub/1',
            activated: true,
          },
        ]),
    })
  );

  expect(results.loopback).toMatchObject({
    state: 'pass',
    message: 'settings.troubleshootLoopbackReceived',
  });
});

test('a gateway that cannot reach the push service fails the loopback', async () => {
  const results = await run(
    deps({ sendDiagnostic: () => Promise.resolve({ kind: 'unforwarded' }) })
  );

  expect(results.loopback?.state).toBe('fail');
  expect(results.loopback?.message).toBe('settings.troubleshootLoopbackUnforwarded');
  expect(results.loopback?.params).toEqual({ host: 'push.example' });
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

test('an iPhone without a push token says why instead of blaming the homeserver', async () => {
  const results = await run(deps({ platform: 'ios', ownPushkey: () => Promise.resolve(null) }));

  expect(results.transport).toMatchObject({
    state: 'fail',
    message: 'settings.troubleshootTransportAppleNoToken',
  });
  expect(results.pusher?.state).toBe('skip');
});

test('a missing pusher says why the last registration failed', async () => {
  const results = await run(
    deps({
      pushers: () => Promise.resolve([]),
      registrationFailure: () => ({ stage: 'homeserver', code: 'denied' }),
    })
  );

  expect(results.pusher?.detail).toEqual({
    message: 'settings.troubleshootFailureHomeserver',
    params: { code: 'denied' },
  });
});

test('an iPhone with no token says what the system refused', async () => {
  const results = await run(
    deps({
      platform: 'ios',
      ownPushkey: () => Promise.resolve(null),
      registrationFailure: () => ({ stage: 'platform', message: 'no aps-environment' }),
    })
  );

  expect(results.transport?.state).toBe('fail');
  expect(results.transport?.detail?.params).toEqual({ message: 'no aps-environment' });
});

test('a passing pusher carries no failure detail', async () => {
  const results = await run(
    deps({ registrationFailure: () => ({ stage: 'platform', message: 'stale' }) })
  );

  expect(results.pusher?.detail).toBeUndefined();
});

function android(provider: string, overrides: Partial<TroubleshootDeps> = {}): TroubleshootDeps {
  return deps({
    platform: 'android',
    nativeTransport: () => Promise.resolve({ provider, distributor: provider }),
    ...overrides,
  });
}

test('background activity passes when battery optimizations are ignored', async () => {
  const results = await run(android('fcm'));

  expect(results.background).toMatchObject({ state: 'pass' });
  expect(results.background?.action).toBeUndefined();
});

test('the built-in connection fails without background activity and offers a fix', async () => {
  const results = await run(
    android('embedded', { ignoringBatteryOptimizations: () => Promise.resolve(false) })
  );

  expect(results.background).toMatchObject({
    state: 'fail',
    message: 'settings.troubleshootBackgroundRequired',
    action: 'allowBackground',
  });
});

test('other providers only warn without background activity', async () => {
  const results = await run(
    android('unifiedpush', { ignoringBatteryOptimizations: () => Promise.resolve(false) })
  );

  expect(results.background).toMatchObject({ state: 'warn', action: 'allowBackground' });
});

test('background and alarms are skipped off Android', async () => {
  const results = await run(deps({ platform: 'ios', ownPushkey: () => Promise.resolve('key') }));

  expect(results.background?.state).toBe('skip');
  expect(results.alarms?.state).toBe('skip');
});

test('alarms are skipped unless the built-in connection is used', async () => {
  const results = await run(
    android('fcm', { canScheduleExactAlarms: () => Promise.resolve(false) })
  );

  expect(results.alarms).toMatchObject({
    state: 'skip',
    message: 'settings.troubleshootAlarmsEmbeddedOnly',
  });
});

test('the built-in connection warns when exact alarms are denied', async () => {
  const results = await run(
    android('embedded', { canScheduleExactAlarms: () => Promise.resolve(false) })
  );

  expect(results.alarms).toMatchObject({ state: 'warn', action: 'allowAlarms' });
});

test('the built-in connection passes with exact alarms allowed', async () => {
  const results = await run(android('embedded'));

  expect(results.alarms?.state).toBe('pass');
});

test('an unreadable setting is skipped', async () => {
  const results = await run(
    android('embedded', {
      ignoringBatteryOptimizations: () => Promise.resolve(null),
      canScheduleExactAlarms: () => Promise.resolve(null),
    })
  );

  expect(results.background?.state).toBe('skip');
  expect(results.alarms?.state).toBe('skip');
});
