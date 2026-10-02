import type { ClientWidgetApi } from 'matrix-widget-api';
import { expect, test, vi } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';
import type { CoreEvent } from '#src/generated/protocol';

import type { SableWidgetDriver } from './widget-driver.js';
import { startWidgetFeed } from './widget-feed.js';

function setup() {
  let listener: ((event: CoreEvent) => void) | undefined;
  const unsubscribe = vi.fn();
  const commands = { setWidgetFeed: vi.fn().mockResolvedValue(undefined) };
  const core = {
    commands,
    subscribeEvents: vi.fn((next: (event: CoreEvent) => void) => {
      listener = next;
      return unsubscribe;
    }),
  } as unknown as CoreClient;
  const api = {
    feedEvent: vi.fn().mockResolvedValue(undefined),
    feedStateUpdate: vi.fn().mockResolvedValue(undefined),
    feedToDevice: vi.fn().mockResolvedValue(undefined),
  };
  const driver = { noteRooms: vi.fn() };
  return {
    core,
    commands,
    api,
    driver,
    unsubscribe,
    emit: (event: CoreEvent) => listener?.(event),
    start: () =>
      startWidgetFeed(
        core,
        api as unknown as ClientWidgetApi,
        driver as unknown as SableWidgetDriver
      ),
  };
}

test('feeds timeline events, and state events as a state update too', () => {
  const { start, emit, api, driver } = setup();
  const stop = start();

  const message = { type: 'm.room.message', room_id: '!a:x', event_id: '$1', content: {} };
  emit({ type: 'widget_room_event', event: message });
  expect(api.feedEvent).toHaveBeenCalledWith(message);
  expect(api.feedStateUpdate).not.toHaveBeenCalled();
  expect(driver.noteRooms).toHaveBeenCalledWith(['!a:x']);

  const state = { type: 'm.room.topic', room_id: '!a:x', state_key: '', content: {} };
  emit({ type: 'widget_room_event', event: state });
  expect(api.feedEvent).toHaveBeenCalledWith(state);
  expect(api.feedStateUpdate).toHaveBeenCalledWith(state);

  stop();
});

test('feeds to-device messages with only what the widget needs', () => {
  const { start, emit, api } = setup();
  const stop = start();

  emit({
    type: 'widget_to_device',
    event: { type: 'com.example.ping', sender: '@a:x', content: { n: 1 }, extra: true },
    encrypted: true,
  });

  expect(api.feedToDevice).toHaveBeenCalledWith(
    { type: 'com.example.ping', sender: '@a:x', content: { n: 1 } },
    true
  );
  stop();
});

test('keeps the core feed on while any widget is open', () => {
  const first = setup();
  const stopFirst = first.start();
  const stopSecond = first.start();
  expect(first.commands.setWidgetFeed).toHaveBeenCalledExactlyOnceWith(true);

  stopFirst();
  expect(first.commands.setWidgetFeed).toHaveBeenCalledTimes(1);
  stopSecond();
  expect(first.commands.setWidgetFeed).toHaveBeenLastCalledWith(false);
  expect(first.unsubscribe).toHaveBeenCalledTimes(2);
});
