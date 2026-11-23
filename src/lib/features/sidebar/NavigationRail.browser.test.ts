import { expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import type { RoomListItemView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js', async () => {
  const mock = await import('#lib/core/__mocks__/context.js');
  return { useCoreClient: () => mock.core, provideCoreClient: vi.fn() };
});
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/rooms/room-list.svelte.js')>()),
  useRoomList: () => ({
    rooms: [],
    quietRoomIds: new Set(),
    section: () => undefined,
    byId: () => undefined,
  }),
}));

import { core } from '#lib/core/__mocks__/context.js';
import { roomUnread } from '#lib/rooms/unread.js';
import { roomView } from '#lib/test-support/room-views.js';
import TooltipProvider from '#lib/ui/primitives/TooltipProvider.svelte';

import NavigationRail from './NavigationRail.svelte';

function space(roomId: string, name: string): RoomListItemView {
  return roomView({ room_id: roomId, name, room_kind: 'space' });
}

test('a closed folder shows its icon', async () => {
  const canvas = new OffscreenCanvas(96, 96);
  canvas.getContext('2d')?.fillRect(0, 0, 96, 96);
  const png = new Uint8Array(await (await canvas.convertToBlob()).arrayBuffer());
  vi.spyOn(core.media, 'fetchMedia').mockResolvedValue(png);

  await render(
    NavigationRail,
    {
      spaces: [space('!a:example.org', 'Alpha'), space('!b:example.org', 'Beta')],
      unreadFor: roomUnread,
      layout: [
        {
          kind: 'folder',
          id: 'f',
          name: 'Work',
          icon: 'mxc://example.org/folder',
          content: ['!a:example.org', '!b:example.org'],
        },
      ],
    },
    { wrapper: TooltipProvider }
  );

  const folder = page.getByRole('treeitem', { name: 'Folder Work' });
  await expect.element(folder).toBeInTheDocument();
  await expect
    .poll(() => folder.element().querySelector('img')?.getBoundingClientRect().height ?? 0)
    .toBeGreaterThan(0);
});
