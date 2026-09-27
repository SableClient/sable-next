// @vitest-environment happy-dom

import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import type { SessionInfo } from '#src/generated/protocol';

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
const core = { commands: { setPusher, removePusher } } as never;
const session = { user_id: '@a:example.org', device_id: 'DEV' } as SessionInfo;

beforeEach(() => {
  config.push = {
    pushNotifyUrl: 'https://push.example/_matrix/push/v1/notify',
    iosVoipPushAppID: 'moe.sable.next.ios.voip',
  };
  token.value = 'voip-1';
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

test('the VoIP token registers once, with the full event for the gateway to filter', async () => {
  await registerVoipPusher(core, session);
  await registerVoipPusher(core, session);

  expect(setPusher).toHaveBeenCalledOnce();
  expect(setPusher).toHaveBeenCalledWith(
    expect.objectContaining({
      pushkey: 'voip-1',
      app_id: 'moe.sable.next.ios.voip',
      event_id_only: false,
    })
  );
});

test('a rotated token replaces the old pusher, and signing off removes it', async () => {
  await registerVoipPusher(core, session);
  await registerVoipPusher(core, session, 'voip-2');

  expect(removePusher).toHaveBeenCalledWith('voip-1', 'moe.sable.next.ios.voip');
  expect(setPusher).toHaveBeenLastCalledWith(expect.objectContaining({ pushkey: 'voip-2' }));

  await unregisterVoipPusher(core);
  expect(removePusher).toHaveBeenLastCalledWith('voip-2', 'moe.sable.next.ios.voip');
});
