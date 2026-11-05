import { beforeEach, expect, test, vi } from 'vitest';

const native = vi.hoisted(() => ({
  invoke: vi.fn<(command: string, args: { active: boolean }) => Promise<void>>(),
  addPluginListener:
    vi.fn<
      (
        plugin: string,
        event: string,
        receive: (event: unknown) => void
      ) => Promise<{ unregister: () => Promise<void> }>
    >(),
}));
vi.mock('@tauri-apps/api/core', () => ({
  isTauri: () => true,
  invoke: native.invoke,
  addPluginListener: native.addPluginListener,
}));

let notifications: typeof import('./native-notifications');

beforeEach(async () => {
  vi.resetAllMocks();
  vi.resetModules();
  notifications = await import('./native-notifications');
});

const watchers = [
  ['watchNativeNotificationClicks', 'set_click_listener_active'],
  ['watchNativeNotificationActions', 'set_action_listener_active'],
  ['watchNativePushMessages', 'set_push_message_listener_active'],
] as const;

test.each(watchers)(
  '%s keeps its replacement active when old setup finishes late',
  async (watch, command) => {
    const registration = Promise.withResolvers<{ unregister: () => Promise<void> }>();
    const unregister = vi.fn().mockResolvedValue(undefined);
    let active = false;
    native.addPluginListener
      .mockReturnValueOnce(registration.promise)
      .mockResolvedValue({ unregister });
    native.invoke.mockImplementation((_command, args) => {
      active = args.active;
      return Promise.resolve();
    });

    const older = notifications[watch](() => {});
    const newer = notifications[watch](() => {});
    registration.resolve({ unregister });
    const [stopOld, stopNew] = await Promise.all([older, newer]);
    stopOld();
    await Promise.resolve();
    expect(active).toBe(true);
    expect(unregister).not.toHaveBeenCalled();
    stopNew();
    await vi.waitFor(() => {
      expect(unregister).toHaveBeenCalledOnce();
    });
    expect(active).toBe(false);
    expect(native.invoke).toHaveBeenLastCalledWith(`plugin:notifications|${command}`, {
      active: false,
    });
  }
);

test.each(watchers)('%s unregisters after activation fails and can be retried', async (watch) => {
  const unregister = vi.fn().mockResolvedValue(undefined);
  native.addPluginListener.mockResolvedValue({ unregister });
  native.invoke.mockRejectedValueOnce(new Error('activation failed')).mockResolvedValue(undefined);

  await expect(notifications[watch](() => {})).rejects.toThrow('activation failed');
  expect(unregister).toHaveBeenCalledOnce();
  const stop = await notifications[watch](() => {});
  stop();
  await vi.waitFor(() => {
    expect(unregister).toHaveBeenCalledTimes(2);
  });
});

test('a new click subscriber waits for a pending shutdown before reactivating', async () => {
  const shutdown = Promise.withResolvers<undefined>();
  const unregister = vi.fn().mockResolvedValue(undefined);
  let active = false;
  native.addPluginListener.mockResolvedValue({ unregister });
  native.invoke.mockImplementation(async (_command, args) => {
    if (!args.active) await shutdown.promise;
    active = args.active;
  });
  const stopOld = await notifications.watchNativeNotificationClicks(() => {});
  stopOld();
  await vi.waitFor(() => {
    expect(native.invoke).toHaveBeenCalledTimes(2);
  });
  const replacement = notifications.watchNativeNotificationClicks(() => {});
  shutdown.resolve(undefined);
  const stopNew = await replacement;
  expect(active).toBe(true);
  stopNew();
  await vi.waitFor(() => {
    expect(unregister).toHaveBeenCalledTimes(2);
  });
});

test('stopping one subscriber leaves only the remaining handler receiving clicks', async () => {
  const unregister = vi.fn().mockResolvedValue(undefined);
  const receivers = new Set<(event: unknown) => void>();
  native.addPluginListener.mockImplementation((_plugin, _event, receive) => {
    receivers.add(receive);
    return Promise.resolve({
      unregister: async () => {
        receivers.delete(receive);
        await unregister();
      },
    });
  });
  native.invoke.mockResolvedValue(undefined);
  const first = vi.fn();
  const second = vi.fn();
  const stopFirst = await notifications.watchNativeNotificationClicks(first);
  const stopSecond = await notifications.watchNativeNotificationClicks(second);
  stopFirst();
  stopFirst();
  const data = { user_id: '@me:example.org', room_id: '!room:example.org', event_id: '$event' };
  for (const receive of receivers) receive({ data });
  expect(first).not.toHaveBeenCalled();
  expect(second).toHaveBeenCalledOnce();
  expect(second).toHaveBeenCalledWith({
    userId: data.user_id,
    roomId: data.room_id,
    eventId: data.event_id,
  });
  stopSecond();
  await vi.waitFor(() => {
    expect(unregister).toHaveBeenCalledOnce();
  });
});

test('aborting setup before registration completes does not drain pending notifications', async () => {
  const registration = Promise.withResolvers<{ unregister: () => Promise<void> }>();
  const unregister = vi.fn().mockResolvedValue(undefined);
  native.addPluginListener.mockReturnValue(registration.promise);
  native.invoke.mockResolvedValue(undefined);
  const controller = new AbortController();
  const watching = notifications.watchNativeNotificationClicks(vi.fn(), controller.signal);
  await vi.waitFor(() => {
    expect(native.addPluginListener).toHaveBeenCalledOnce();
  });
  controller.abort();
  registration.resolve({ unregister });
  await watching;
  expect(unregister).toHaveBeenCalledOnce();
  expect(native.invoke).not.toHaveBeenCalled();
});

test('failure of one event does not prevent another event from being cleaned up', async () => {
  const unregisterAction = vi.fn().mockResolvedValue(undefined);
  const unregisterClick = vi.fn().mockResolvedValue(undefined);
  native.addPluginListener.mockImplementation((_plugin, event) =>
    Promise.resolve({
      unregister: event === 'actionPerformed' ? unregisterAction : unregisterClick,
    })
  );
  native.invoke.mockImplementation((command, args) => {
    if (command.endsWith('set_action_listener_active') && args.active)
      return Promise.reject(new Error('activation failed'));
    return Promise.resolve();
  });
  const controller = new AbortController();
  const action = notifications.watchNativeNotificationActions(vi.fn(), controller.signal);
  const click = notifications.watchNativeNotificationClicks(vi.fn(), controller.signal);
  await expect(action).rejects.toThrow('activation failed');
  await click;
  controller.abort();
  await vi.waitFor(() => {
    expect(unregisterClick).toHaveBeenCalledOnce();
  });
  expect(unregisterAction).toHaveBeenCalledOnce();
});
