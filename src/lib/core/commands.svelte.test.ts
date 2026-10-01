import { expect, test, vi } from 'vitest';
import type { Transport } from '#src/transport';
import { createCommands } from './commands.svelte.js';

test.each([false, true])('loads room packs (cachedOnly=%s)', async (cachedOnly) => {
  const send = vi.fn(() =>
    Promise.resolve({ type: 'image_packs', packs: [], complete: !cachedOnly })
  );
  const commands = createCommands(() => ({ send }) as unknown as Transport);

  await expect(commands.imagePackListing('!room:example.org', cachedOnly)).resolves.toEqual({
    packs: [],
    complete: !cachedOnly,
  });
  expect(send).toHaveBeenCalledExactlyOnceWith({
    type: 'image_packs',
    room_id: '!room:example.org',
    cached_only: cachedOnly,
  });
});

test('leaves account-wide listings uncached', async () => {
  const send = vi.fn(() => Promise.resolve({ type: 'all_image_packs', packs: [] }));
  const commands = createCommands(() => ({ send }) as unknown as Transport);

  await expect(commands.imagePackListing('', true)).resolves.toEqual({
    packs: [],
    complete: false,
  });
  expect(send).not.toHaveBeenCalled();
  await expect(commands.imagePackListing('')).resolves.toEqual({ packs: [], complete: false });
  expect(send).toHaveBeenCalledExactlyOnceWith({ type: 'all_image_packs' });
});
