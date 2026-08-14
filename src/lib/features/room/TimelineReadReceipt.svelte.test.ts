// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { expect, test, vi } from 'vitest';

import type { TimelineItemView } from '@/generated/TimelineItemView';
import type { CoreClient } from '$lib/core/client.svelte';
import { RoomTimeline } from '$lib/rooms/timeline.svelte';

import TimelineReadReceipt from './TimelineReadReceipt.svelte';

function item(): TimelineItemView {
  return {
    id: 'latest',
    event_id: '$latest',
    transaction_id: null,
    send_state: null,
    sender: '@alice:example.org',
    sender_name: 'Alice',
    sender_avatar: null,
    timestamp: 0,
    content: { kind: 'message', body: 'latest', html: 'latest', emote: false, edited: false },
    in_reply_to: null,
    thread_root: null,
    thread_summary: null,
    reactions: [],
    is_own: false,
    read_by: [],
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

test('does not duplicate a read receipt while the first request is pending', async () => {
  const timeline = new RoomTimeline({} as CoreClient);
  timeline.items = [item()];
  const pending = deferred<undefined>();
  const read = vi.fn(() => pending.promise);
  const instance = mount(TimelineReadReceipt, {
    target: document.body,
    props: {
      timeline,
      focusEventId: null,
      initialAnchorComplete: true,
      nearLatest: true,
      onRead: read,
    },
  });

  await tick();
  timeline.items = [...timeline.items];
  await tick();

  expect(read).toHaveBeenCalledTimes(1);
  pending.resolve(undefined);
  await unmount(instance);
});
