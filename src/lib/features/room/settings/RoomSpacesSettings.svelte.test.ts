// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import type { RoomSummary } from '#src/generated/protocol';

const goto = vi.hoisted(() => vi.fn());

vi.mock('$app/navigation', () => ({ goto }));
vi.mock('#lib/core/context.js');
vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/rooms/room-list.svelte.js')>()),
  useRoomList: () => ({
    rooms: [],
    byId: (id: string) => (id === '!joined:home.example' ? { room_id: id } : undefined),
    labelFor: (id: string) => id,
  }),
}));

import { core as baseCore } from '#lib/core/__mocks__/context.js';

import RoomSpacesSettings from './RoomSpacesSettings.svelte';

const core = Object.assign(baseCore, {
  roomStateEventsRaw: vi.fn<(...args: never[]) => Promise<unknown[]>>(() =>
    Promise.resolve([
      {
        state_key: '!joined:home.example',
        content: { via: ['home.example'], canonical: true },
      },
      { state_key: '!other:far.example', content: { via: ['far.example'] } },
    ])
  ),
  joinRoom: vi.fn<(...args: never[]) => Promise<string>>(() =>
    Promise.resolve('!other:far.example')
  ),
});

const room = { room_id: '!room:home.example' } as RoomSummary;

afterEach(() => {
  vi.clearAllMocks();
});

test('a joined parent space opens', async () => {
  const user = userEvent.setup();
  render(RoomSpacesSettings, { room });

  await user.click(await screen.findByRole('button', { name: 'room.spaceOpen' }));

  expect(goto).toHaveBeenCalledOnce();
});

test('an unjoined parent space is joined through its via servers, then opened', async () => {
  const user = userEvent.setup();
  render(RoomSpacesSettings, { room });

  await user.click(await screen.findByRole('button', { name: 'common.join' }));

  expect(core.joinRoom).toHaveBeenCalledWith('!other:far.example', ['far.example']);
  expect(goto).toHaveBeenCalledOnce();
});
