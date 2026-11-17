import { expect, test, vi } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';

import { image } from './attachment-fixtures';
import { RoomAttachmentsPager } from './room-attachments-pager.svelte';

async function settle(): Promise<void> {
  for (let step = 0; step < 4; step += 1) await Promise.resolve();
}

test('a retry re-requests the failed page and keeps the loaded ones', async () => {
  const roomAttachments = vi
    .fn()
    .mockResolvedValueOnce({ items: [image('$a')], next_batch: 'page-2' })
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ items: [image('$b')], next_batch: null });
  const pager = new RoomAttachmentsPager(
    {
      rpc: { rooms: { attachments: roomAttachments } },
    } as unknown as CoreClient,
    'media'
  );

  pager.sync('!room');
  await settle();
  pager.loadMore();
  await settle();
  expect(pager.failed).toBe(true);
  expect(pager.items.map((item) => item.event_id)).toEqual(['$a']);

  pager.retry();
  await settle();

  expect(roomAttachments).toHaveBeenLastCalledWith({
    room_id: '!room',
    kind: 'media',
    limit: 30,
    from: 'page-2',
  });
  expect(pager.items.map((item) => item.event_id)).toEqual(['$a', '$b']);
  expect(pager.failed).toBe(false);
  expect(pager.exhausted).toBe(true);
});
