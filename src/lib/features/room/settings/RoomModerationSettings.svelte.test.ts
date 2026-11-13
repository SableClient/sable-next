// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';

import type {
  RoomListItemView,
  RoomPermissionsView,
  RoomPowerLevelsView,
} from '#src/generated/protocol';

vi.mock('#lib/core/context.js');
vi.mock('#lib/i18n.js', () => import('#lib/test-support/i18n.js'));
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/rooms/room-list.svelte.js')>()),
  useRoomList: () => ({
    rooms: [],
    byId: (id: string) =>
      id === '!lobby:example.org' ? { room_id: id, display_name: 'Lobby' } : undefined,
  }),
}));

import { core } from '#lib/core/__mocks__/context.js';

import RoomModerationSettings from './RoomModerationSettings.svelte';

const room = { room_id: '!management:example.org' } as RoomListItemView;
const levels: RoomPowerLevelsView = {
  ban: 50,
  kick: 50,
  redact: 50,
  invite: 0,
  events_default: 0,
  state_default: 50,
  users_default: 0,
  events: {},
  users: {},
  notifications_room: 50,
};
const admin = { own_power_level: 100 } as RoomPermissionsView;
const member = { own_power_level: 0 } as RoomPermissionsView;

let state: Record<string, unknown>;
const fullState = vi.fn(() =>
  Promise.resolve(
    Object.entries(state).map(([type, content]) => ({ type, state_key: '', content }))
  )
);
const sendEvent = vi.fn((params: { event_type: string; content: unknown }) => {
  state[params.event_type] = params.content;
  return Promise.resolve('$event');
});
Object.assign(core.rpc.room_state, { fullState, sendEvent });

beforeEach(() => {
  vi.clearAllMocks();
  state = {
    'fi.mau.meowlnir.protected_rooms': {
      rooms: ['!lobby:example.org'],
      skip_acl: [],
      obfuscate_bans: true,
      protections: { from_the_future: { level: 2 } },
    },
    'fi.mau.meowlnir.watched_lists': {
      lists: [
        { room_id: '!first:example.org', shortcode: 'first', auto_unban: true },
        { room_id: '!second:example.org', shortcode: 'second' },
      ],
    },
  };
});

test('turning a protection on keeps the settings this client does not model', async () => {
  const user = userEvent.setup();
  render(RoomModerationSettings, { room, permissions: admin, levels });

  await user.click(
    await screen.findByRole('switch', { name: 'room.moderationProtection.no_media' })
  );

  await vi.waitFor(() => {
    expect(sendEvent).toHaveBeenCalledWith({
      room_id: '!management:example.org',
      event_type: 'fi.mau.meowlnir.protected_rooms',
      state_key: '',
      content: {
        rooms: ['!lobby:example.org'],
        skip_acl: [],
        obfuscate_bans: true,
        protections: { from_the_future: { level: 2 }, no_media: {} },
      },
    });
  });
  expect(
    await screen.findByRole('switch', {
      name: 'room.moderationProtection.no_media: room.moderationField.allow_images',
    })
  ).not.toBeChecked();
  expect(screen.getByText('from_the_future')).toBeInTheDocument();
});

test('a change is applied to what the server holds, not to what was loaded', async () => {
  const user = userEvent.setup();
  render(RoomModerationSettings, { room, permissions: admin, levels });
  const toggle = await screen.findByRole('switch', {
    name: 'room.moderationServerBansIn:Lobby',
  });
  state['fi.mau.meowlnir.protected_rooms'] = {
    rooms: ['!lobby:example.org', '!added-elsewhere:example.org'],
    skip_acl: [],
  };

  await user.click(toggle);

  await vi.waitFor(() => {
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        content: {
          rooms: ['!lobby:example.org', '!added-elsewhere:example.org'],
          skip_acl: ['!lobby:example.org'],
        },
      })
    );
  });
});

test('lists are reordered by precedence', async () => {
  const user = userEvent.setup();
  render(RoomModerationSettings, { room, permissions: admin, levels });

  await user.click(await screen.findByRole('button', { name: 'room.moderationListUp:second' }));

  await vi.waitFor(() => {
    expect(sendEvent).toHaveBeenCalledWith(
      expect.objectContaining({
        event_type: 'fi.mau.meowlnir.watched_lists',
        content: {
          lists: [
            { room_id: '!second:example.org', shortcode: 'second' },
            { room_id: '!first:example.org', shortcode: 'first', auto_unban: true },
          ],
        },
      })
    );
  });
});

test('a failed save says so and shows the server state again', async () => {
  sendEvent.mockRejectedValueOnce(new Error('denied'));
  const user = userEvent.setup();
  render(RoomModerationSettings, { room, permissions: admin, levels });
  const toggle = await screen.findByRole('switch', {
    name: 'room.moderationProtection.anti_flood',
  });

  await user.click(toggle);

  await vi.waitFor(() => {
    expect(fullState).toHaveBeenCalledTimes(3);
  });
  await vi.waitFor(() => {
    expect(toggle).not.toBeChecked();
  });
});

test('members without the role see the setup but cannot change it', async () => {
  render(RoomModerationSettings, { room, permissions: member, levels });

  expect(await screen.findByText('room.moderationReadOnly')).toBeInTheDocument();
  const rooms = screen.getByRole('region', { name: 'room.moderationRooms' });
  expect(within(rooms).getByText('Lobby')).toBeInTheDocument();
  expect(screen.getByRole('switch', { name: 'room.moderationProtection.no_media' })).toBeDisabled();
  expect(screen.queryByRole('button', { name: 'room.moderationProtect' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'room.moderationUnwatch:first' })).toBeNull();
});
