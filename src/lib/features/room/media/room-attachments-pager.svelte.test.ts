import type { RoomAttachmentView } from '#src/generated/protocol';
import { expect, test, vi } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';

import { RoomAttachmentsPager } from './room-attachments-pager.svelte';

function attachment(eventId: string): RoomAttachmentView {
  return { event_id: eventId, gallery_index: null } as RoomAttachmentView;
}

async function settle(): Promise<void> {
  for (let step = 0; step < 4; step += 1) await Promise.resolve();
}

test('a retry re-requests the failed page and keeps the loaded ones', async () => {
  const roomAttachments = vi
    .fn()
    .mockResolvedValueOnce({ items: [attachment('$a')], next_batch: 'page-2' })
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce({ items: [attachment('$b')], next_batch: null });
  const pager = new RoomAttachmentsPager({
    commands: { roomAttachments },
  } as unknown as CoreClient);

  pager.sync('!room');
  await settle();
  pager.loadMore();
  await settle();
  expect(pager.failed).toBe(true);
  expect(pager.items.map((item) => item.event_id)).toEqual(['$a']);

  pager.retry();
  await settle();

  expect(roomAttachments).toHaveBeenLastCalledWith('!room', 'media', 30, 'page-2');
  expect(pager.items.map((item) => item.event_id)).toEqual(['$a', '$b']);
  expect(pager.failed).toBe(false);
  expect(pager.exhausted).toBe(true);
});
