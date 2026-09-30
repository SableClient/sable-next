// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { SessionInfo } from '#src/generated/protocol';
import type { CoreClient } from '#lib/core/client.svelte.js';

const config = vi.hoisted(() => ({ push: null as Record<string, unknown> | null }));
const token = vi.hoisted(() => ({ value: null as string | null }));

vi.mock('#lib/config/runtime-config.js', () => ({
  runtimeConfig: () => Promise.resolve(config),
}));
vi.mock('#lib/platform/calls.js', () => ({
  nativeVoipToken: () => Promise.resolve(token.value),
}));

import { registerVoipPusher, unregisterVoipPusher } from './voip-push';

const setPusher = vi.fn(() => Promise.resolve());
const removePusher = vi.fn(() => Promise.resolve());
const session = { user_id: '@a:example.org', device_id: 'DEV' } as SessionInfo;
const core = {
  commands: { setPusher, removePusher },
  session,
  deviceList: [{ is_own: true, display_name: 'My phone' }],
} as unknown as CoreClient;

beforeEach(() => {
  config.push = {
    pushNotifyUrl: 'https://push.example/_matrix/push/v1/notify',
    iosVoipPushAppID: 'moe.sable.next.ios.voip',
  };
  token.value = 'voip-1';
  Object.assign(core, { deviceList: [{ is_own: true, display_name: 'My phone' }] });
});

afterEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
});

test('nothing registers without a VoIP app id', async () => {
  config.push = { pushNotifyUrl: 'https://push.example/_matrix/push/v1/notify' };
  await registerVoipPusher(core, session);

  expect(setPusher).not.toHaveBeenCalled();
});

test('registers a VoIP token once with full events', async () => {
  await registerVoipPusher(core, session);
  await registerVoipPusher(core, session);

  expect(setPusher).toHaveBeenCalledOnce();
  expect(setPusher).toHaveBeenCalledWith(
    expect.objectContaining({
      pushkey: 'voip-1',
      app_id: 'moe.sable.next.ios.voip',
      event_id_only: false,
      device_display_name: 'My phone',
    })
  );
});

test('updates the VoIP pusher after a device rename', async () => {
  await registerVoipPusher(core, session);
  await registerVoipPusher(core, session);
  Object.assign(core, { deviceList: [{ is_own: true, display_name: 'Work phone' }] });
  await registerVoipPusher(core, session);

  expect(setPusher).toHaveBeenCalledTimes(2);
  expect(setPusher).toHaveBeenLastCalledWith(
    expect.objectContaining({ pushkey: 'voip-1', device_display_name: 'Work phone' })
  );
  expect(removePusher).not.toHaveBeenCalled();
});

test('updates VoIP registrations saved without a device name', async () => {
  localStorage.setItem(
    'sable.push.voip',
    JSON.stringify({ userId: session.user_id, appId: 'moe.sable.next.ios.voip', pushkey: 'voip-1' })
  );
  await registerVoipPusher(core, session);

  expect(setPusher).toHaveBeenCalledWith(
    expect.objectContaining({ device_display_name: 'My phone' })
  );
  expect(removePusher).not.toHaveBeenCalled();
});

test('a rotated token replaces the old pusher, and signing off removes it', async () => {
  await registerVoipPusher(core, session);
  await registerVoipPusher(core, session, 'voip-2');

  expect(removePusher).toHaveBeenCalledWith('voip-1', 'moe.sable.next.ios.voip');
  expect(setPusher).toHaveBeenLastCalledWith(expect.objectContaining({ pushkey: 'voip-2' }));

  await unregisterVoipPusher(core);
  expect(removePusher).toHaveBeenLastCalledWith('voip-2', 'moe.sable.next.ios.voip');
});
