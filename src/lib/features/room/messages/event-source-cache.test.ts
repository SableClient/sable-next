import { expect, test, vi } from 'vitest';

import { readEventSource } from './event-source-cache';

test('an encrypted source is read again, a clear one is kept', async () => {
  const read = vi
    .fn<(roomId: string, eventId: string) => Promise<string>>()
    .mockResolvedValueOnce('{"type":"m.room.encrypted","content":{}}')
    .mockResolvedValueOnce('{"type":"m.room.message","content":{"body":"hi"}}');

  await expect(readEventSource(read, '!room:x', '$late')).resolves.toMatchObject({
    type: 'm.room.encrypted',
  });
  await expect(readEventSource(read, '!room:x', '$late')).resolves.toMatchObject({
    content: { body: 'hi' },
  });
  await readEventSource(read, '!room:x', '$late');

  expect(read).toHaveBeenCalledTimes(2);
});
