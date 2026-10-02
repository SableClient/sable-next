import type { ClientWidgetApi, IRoomEvent } from 'matrix-widget-api';

import type { CoreClient } from '#lib/core/client.svelte.js';

import type { SableWidgetDriver } from './widget-driver.js';

const consumers = new WeakMap<CoreClient, number>();

function acquire(core: CoreClient): void {
  const count = consumers.get(core) ?? 0;
  consumers.set(core, count + 1);
  if (count === 0) core.commands.setWidgetFeed(true).catch(() => undefined);
}

function release(core: CoreClient): void {
  const count = (consumers.get(core) ?? 1) - 1;
  consumers.set(core, count);
  if (count === 0) core.commands.setWidgetFeed(false).catch(() => undefined);
}

export function startWidgetFeed(
  core: CoreClient,
  api: ClientWidgetApi,
  driver: SableWidgetDriver
): () => void {
  acquire(core);
  const unsubscribe = core.subscribeEvents((event) => {
    if (event.type === 'widget_room_event') {
      const raw = event.event as IRoomEvent;
      driver.noteRooms([raw.room_id]);
      api.feedEvent(raw).catch(() => undefined);
      if ('state_key' in raw) api.feedStateUpdate(raw).catch(() => undefined);
    } else if (event.type === 'widget_to_device') {
      const { type, sender, content } = event.event as {
        type: string;
        sender: string;
        content: Record<string, unknown>;
      };
      api.feedToDevice({ type, sender, content }, event.encrypted).catch(() => undefined);
    }
  });

  return () => {
    unsubscribe();
    release(core);
  };
}
