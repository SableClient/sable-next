import { expect, test, vi } from 'vitest';

import { RoomCosmetics } from './room-cosmetics.svelte.js';

test('loads space colors and pronouns', async () => {
  const userId = '@alice:example.org';
  const store = new RoomCosmetics({
    commands: {
      roomCosmetics: vi.fn().mockResolvedValue({
        space_id: '!space:example.org',
        users: [
          {
            user_id: userId,
            color_on_light: '#123456',
            color_on_dark: '#abcdef',
            pronouns: [{ summary: 'she/her', language: null }],
            space_display_name: 'Space Alice',
            space_avatar_url: 'mxc://example.org/space',
          },
        ],
      }),
    },
    subscribeEvents: () => () => {},
  });

  await store.load('!room:example.org', '!space:example.org');

  expect(store.for(userId)).toEqual({
    colorOnLight: '#123456',
    colorOnDark: '#abcdef',
    pronouns: [{ summary: 'she/her', language: null }],
  });
  expect(store.for('@unknown:example.org')).toBeNull();
});
