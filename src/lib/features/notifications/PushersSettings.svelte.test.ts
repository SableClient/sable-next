// @vitest-environment happy-dom

import { mount, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { RegisteredPusherView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');
vi.mock('#lib/config/runtime-config.js', () => ({
  runtimeConfig: vi.fn(() =>
    Promise.resolve({
      push: {
        pushNotifyUrl: 'https://gateway.example.org/_matrix/push/v1/notify',
        vapidPublicKey: 'VAPID',
        webPushAppID: 'moe.sable.webpush',
        nativePushAppID: null,
      },
      gifs: null,
      homeservers: null,
      calls: null,
    })
  ),
}));

import { core as baseCore } from '#lib/core/__mocks__/context.js';

const core = Object.assign(baseCore, {
  webPushers: vi.fn<() => Promise<RegisteredPusherView[]>>(),
  removePusher: vi.fn<(pushkey: string, appId: string) => Promise<void>>(),
});

import PushersSettings from './PushersSettings.svelte';

const gateway: RegisteredPusherView = {
  pushkey: 'KEY-GATEWAY',
  app_id: 'im.vector.app',
  kind: 'http',
  device_display_name: 'Element on phone',
  activated: null,
  gateway: null,
};

const ownServer: RegisteredPusherView = {
  pushkey: 'p256dh-own',
  app_id: 'moe.sable.webpush',
  kind: 'org.matrix.msc4174.webpush',
  device_display_name: 'This browser',
  activated: false,
  gateway: null,
};

const unnamed: RegisteredPusherView = {
  pushkey: 'KEY-EMAIL',
  app_id: 'im.example.email',
  kind: 'email',
  device_display_name: null,
  activated: null,
  gateway: null,
};

afterEach(() => {
  document.body.replaceChildren();
  Reflect.deleteProperty(navigator, 'serviceWorker');
  vi.clearAllMocks();
});

test('lists registered pushers and marks the Sable ones', async () => {
  core.webPushers.mockResolvedValue([gateway, ownServer, unnamed]);

  const instance = mount(PushersSettings, { target: document.body });
  await vi.waitFor(() => {
    expect(document.querySelectorAll('.pusher').length).toBe(3);
  });

  const names = [...document.querySelectorAll('.pusher-name')].map((node) => node.textContent);
  expect(names).toEqual(['Element on phone', 'This browser', 'im.example.email']);
  expect(document.querySelector('.pusher-name-line .status-badge-neutral')?.textContent).toBe(
    'Sable'
  );
  expect(document.querySelector('.pusher-name-line .status-badge-primary')).toBeNull();
  expect(document.querySelector('.status-badge-warning')?.textContent).toBe(
    'Awaiting confirmation'
  );

  await unmount(instance);
});

test('marks this browser own pusher as this device', async () => {
  Object.defineProperty(navigator, 'serviceWorker', {
    configurable: true,
    value: {
      getRegistration: () =>
        Promise.resolve({
          pushManager: {
            getSubscription: () =>
              Promise.resolve({ toJSON: () => ({ keys: { p256dh: 'p256dh-own' } }) }),
          },
        }),
    },
  });
  core.webPushers.mockResolvedValue([gateway, ownServer, unnamed]);

  const instance = mount(PushersSettings, { target: document.body });
  await vi.waitFor(() => {
    expect(document.querySelector('.pusher-name-line .status-badge-primary')?.textContent).toBe(
      'This device'
    );
  });
  expect(document.querySelectorAll('.status-badge-primary').length).toBe(1);

  await unmount(instance);
});

test('removes a pusher once the inline confirmation is accepted', async () => {
  core.webPushers.mockResolvedValueOnce([gateway, ownServer]).mockResolvedValueOnce([ownServer]);
  core.removePusher.mockResolvedValue(undefined);

  const instance = mount(PushersSettings, { target: document.body });
  await vi.waitFor(() => {
    expect(document.querySelectorAll('.pusher').length).toBe(2);
  });

  document.querySelector<HTMLButtonElement>('.pusher-summary .btn-danger')?.click();
  await vi.waitFor(() => {
    expect(document.querySelector('.pusher-confirm')).not.toBeNull();
  });

  document.querySelector<HTMLButtonElement>('.pusher-confirm .btn-danger')?.click();
  await vi.waitFor(() => {
    expect(core.removePusher).toHaveBeenCalledWith('KEY-GATEWAY', 'im.vector.app');
  });

  await unmount(instance);
});

test('cancels a removal confirmation', async () => {
  core.webPushers.mockResolvedValue([gateway]);

  const instance = mount(PushersSettings, { target: document.body });
  await vi.waitFor(() => {
    expect(document.querySelectorAll('.pusher').length).toBe(1);
  });

  document.querySelector<HTMLButtonElement>('.pusher-summary .btn-danger')?.click();
  await vi.waitFor(() => {
    expect(document.querySelector('.pusher-confirm')).not.toBeNull();
  });

  document.querySelector<HTMLButtonElement>('.pusher-confirm .btn-ghost')?.click();
  await vi.waitFor(() => {
    expect(document.querySelector('.pusher-confirm')).toBeNull();
  });

  expect(core.removePusher).not.toHaveBeenCalled();

  await unmount(instance);
});

test('shows an empty state when no pusher is registered', async () => {
  core.webPushers.mockResolvedValue([]);

  const instance = mount(PushersSettings, { target: document.body });
  await vi.waitFor(() => {
    expect(document.querySelector('.pushers-empty')?.textContent).toContain(
      'No apps are registered'
    );
  });

  await unmount(instance);
});

test('copies the cropped value in full on click', async () => {
  const writeText = vi.spyOn(navigator.clipboard, 'writeText').mockResolvedValue(undefined);
  core.webPushers.mockResolvedValue([gateway]);

  const instance = mount(PushersSettings, { target: document.body });
  await vi.waitFor(() => {
    expect(document.querySelectorAll('.pusher').length).toBe(1);
  });

  document.querySelector<HTMLButtonElement>('[aria-label="Copy the push key"]')?.click();
  await vi.waitFor(() => {
    expect(writeText).toHaveBeenCalledWith('KEY-GATEWAY');
    expect(document.querySelector('.pusher-meta')?.textContent).toContain('Copied');
  });

  await unmount(instance);
});

test('reports a load failure instead of an empty list', async () => {
  core.webPushers.mockRejectedValue(new Error('offline'));

  const instance = mount(PushersSettings, { target: document.body });
  await vi.waitFor(() => {
    expect(document.querySelector('.alert')?.textContent).toContain(
      'registered apps could not be loaded'
    );
  });

  await unmount(instance);
});
