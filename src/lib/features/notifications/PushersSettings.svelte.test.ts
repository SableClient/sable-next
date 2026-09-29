// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
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
  gateway: 'https://ntfy.example.org/_matrix/push/v1/notify',
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
  Reflect.deleteProperty(navigator, 'serviceWorker');
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

async function pushers(count: number): Promise<HTMLElement[]> {
  render(PushersSettings);
  await vi.waitFor(() => {
    expect(screen.getAllByRole('listitem')).toHaveLength(count);
  });
  return screen.getAllByRole('listitem');
}

test('lists registered pushers and marks the Sable ones', async () => {
  core.webPushers.mockResolvedValue([gateway, ownServer, unnamed]);

  const [phone, browser, email] = await pushers(3);

  expect(phone.querySelector('.pusher-name')).toHaveTextContent('Element on phone');
  expect(browser.querySelector('.pusher-name')).toHaveTextContent('This browser');
  expect(email.querySelector('.pusher-name')).toHaveTextContent('im.example.email');
  expect(
    within(phone).getByRole('button', { name: 'Copy the push gateway URL' })
  ).toHaveTextContent('https://ntfy.example.org/_matrix/push/v1/notify');
  expect(within(browser).getByText('Sable')).toHaveClass('status-badge-neutral');
  expect(screen.queryByText('This device')).not.toBeInTheDocument();
  expect(within(browser).getByText('Awaiting confirmation')).toHaveClass('status-badge-warning');
});

test('marks this browser own pusher as this device', async () => {
  vi.stubGlobal('PushManager', function PushManager() {});
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

  const [, browser] = await pushers(3);
  expect(await within(browser).findByText('This device')).toHaveClass('status-badge-primary');
  expect(screen.getAllByText('This device')).toHaveLength(1);
});

test('removes a pusher once the inline confirmation is accepted', async () => {
  const user = userEvent.setup();
  core.webPushers.mockResolvedValueOnce([gateway, ownServer]).mockResolvedValueOnce([ownServer]);
  core.removePusher.mockResolvedValue(undefined);

  const [phone] = await pushers(2);
  await user.click(within(phone).getByRole('button', { name: 'Remove' }));
  expect(
    within(phone).getByText('Stop sending notifications to Element on phone?')
  ).toBeInTheDocument();

  await user.click(within(phone).getByRole('button', { name: 'Remove Element on phone' }));
  await vi.waitFor(() => {
    expect(core.removePusher).toHaveBeenCalledWith('KEY-GATEWAY', 'im.vector.app');
  });
});

test('cancels a removal confirmation', async () => {
  const user = userEvent.setup();
  core.webPushers.mockResolvedValue([gateway]);

  const [phone] = await pushers(1);
  await user.click(within(phone).getByRole('button', { name: 'Remove' }));
  await user.click(within(phone).getByRole('button', { name: 'Cancel' }));

  expect(
    screen.queryByText('Stop sending notifications to Element on phone?')
  ).not.toBeInTheDocument();
  expect(core.removePusher).not.toHaveBeenCalled();
});

test('shows an empty state when no pusher is registered', async () => {
  core.webPushers.mockResolvedValue([]);

  render(PushersSettings);
  expect(await screen.findByText(/No apps are registered/)).toBeInTheDocument();
});

test('copies the cropped value in full on click', async () => {
  const user = userEvent.setup();
  core.webPushers.mockResolvedValue([gateway]);

  const [phone] = await pushers(1);
  await user.click(within(phone).getByRole('button', { name: 'Copy the push key' }));

  expect(await navigator.clipboard.readText()).toBe('KEY-GATEWAY');
  expect(await within(phone).findByText('Copied')).toBeInTheDocument();
});

test('copies the full push gateway URL', async () => {
  const user = userEvent.setup();
  core.webPushers.mockResolvedValue([gateway]);

  const [phone] = await pushers(1);
  await user.click(within(phone).getByRole('button', { name: 'Copy the push gateway URL' }));

  expect(await navigator.clipboard.readText()).toBe(
    'https://ntfy.example.org/_matrix/push/v1/notify'
  );
  expect(await within(phone).findByRole('button', { name: 'Copied' })).toBeInTheDocument();
});

test('reports a load failure instead of an empty list', async () => {
  core.webPushers.mockRejectedValue(new Error('offline'));

  render(PushersSettings);
  await vi.waitFor(() => {
    expect(screen.getByRole('status')).toHaveTextContent('registered apps could not be loaded');
  });
  expect(screen.queryByText(/No apps are registered/)).not.toBeInTheDocument();
});
