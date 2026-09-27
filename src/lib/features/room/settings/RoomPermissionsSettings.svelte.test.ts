// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import type {
  RoomPermissionsView,
  RoomPowerLevelsView,
  RoomSummary,
} from '#src/generated/protocol';

const { space, extraRooms } = vi.hoisted(() => ({
  extraRooms: [] as { room_id: string; state: string; space_children: [] }[],
  space: {
    room_id: '!space:example.org',
    name: 'Guild',
    is_space: true,
    state: 'joined',
    space_children: [{ room_id: '!room:example.org' }],
  },
}));

vi.mock('#lib/core/context.js');
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));

vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  useRoomList: () => ({
    rooms: [space, ...extraRooms],
    byId: (id: string) => (id === space.room_id ? space : undefined),
  }),
}));

import { core as baseCore } from '#lib/core/__mocks__/context.js';

const core = Object.assign(baseCore, {
  roomPowerLevels: vi.fn<(roomId: string) => Promise<RoomPowerLevelsView>>(),
  roomStateEvent: vi.fn<(roomId: string, eventType: string) => Promise<unknown>>(),
  roomPermissions: vi.fn<(roomId: string) => Promise<RoomPermissionsView>>(),
  sendStateEvent:
    vi.fn<
      (roomId: string, eventType: string, stateKey: string, content: unknown) => Promise<void>
    >(),
});

import RoomPermissionsSettings from './RoomPermissionsSettings.svelte';

const base: RoomPowerLevelsView = {
  ban: 50,
  kick: 50,
  redact: 50,
  invite: 0,
  events_default: 0,
  state_default: 50,
  users_default: 0,
  events: {},
  users: { '@admin:example.org': 100 },
  notifications_room: 50,
};

const room = { room_id: '!room:example.org', is_space: false } as RoomSummary;

const permissions = {
  own_power_level: 100,
  can_change_power_levels: true,
} as RoomPermissionsView;

afterEach(() => {
  extraRooms.length = 0;
});

test('syncing copies the parent space levels and roles into the room', async () => {
  core.session = { user_id: '@admin:example.org' };
  core.roomPowerLevels.mockImplementation((roomId) =>
    Promise.resolve(
      roomId === space.room_id
        ? {
            ...base,
            ban: 75,
            events_default: 100,
            users: { '@admin:example.org': 100, '@mod:example.org': 50 },
          }
        : base
    )
  );
  core.roomStateEvent.mockImplementation((roomId) =>
    Promise.resolve(roomId === space.room_id ? { '50': { name: 'Moderator' } } : null)
  );
  core.sendStateEvent.mockResolvedValue(undefined);

  const user = userEvent.setup();
  render(RoomPermissionsSettings, { room, permissions });
  expect(await screen.findByText(/Sync with Guild/)).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Sync' }));
  await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Sync' }));

  await vi.waitFor(() => {
    expect(core.sendStateEvent).toHaveBeenCalledTimes(2);
  });
  expect(core.sendStateEvent).toHaveBeenCalledWith(
    '!room:example.org',
    'm.room.power_levels',
    '',
    expect.objectContaining({
      ban: 75,
      events_default: 0,
      users: { '@admin:example.org': 100, '@mod:example.org': 50 },
    })
  );
  expect(core.sendStateEvent).toHaveBeenCalledWith(
    '!room:example.org',
    'in.cinny.room.power_level_tags',
    '',
    { '50': { name: 'Moderator' } }
  );
});

test('saves a role emoji with its name and colour', async () => {
  core.session = { user_id: '@admin:example.org' };
  core.roomPowerLevels.mockResolvedValue(base);
  core.roomStateEvent.mockResolvedValue({
    '50': { name: 'Sentinel', color: '#ff0000' },
  });
  core.sendStateEvent.mockResolvedValue(undefined);

  const user = userEvent.setup();
  render(RoomPermissionsSettings, { room, permissions });
  await vi.waitFor(() => {
    expect(document.querySelector('.role-chip')).toHaveTextContent('Sentinel');
  });

  const row = within(
    document.querySelector<HTMLElement>('.role-chip')?.closest('li') ?? document.body
  );
  await user.click(row.getByRole('button', { name: 'Edit role' }));
  await user.type(screen.getByRole('textbox', { name: 'Icon' }), '🛡️{Enter}');

  await vi.waitFor(() => {
    expect(core.sendStateEvent).toHaveBeenCalledWith(
      '!room:example.org',
      'in.cinny.room.power_level_tags',
      '',
      {
        '50': { name: 'Sentinel', color: '#ff0000', icon: { key: '🛡️' } },
      }
    );
  });
});

test('uses tagged default roles in permission controls and opens their editor', async () => {
  core.session = { user_id: '@admin:example.org' };
  core.roomPowerLevels.mockResolvedValue(base);
  core.roomStateEvent.mockResolvedValue({ '0': { name: 'Test' } });

  const user = userEvent.setup();
  render(RoomPermissionsSettings, { room, permissions });
  await vi.waitFor(() => {
    expect(screen.getByRole('button', { name: 'Invite' })).toHaveTextContent('Test');
  });

  const row = screen
    .getAllByRole('listitem')
    .find(
      (item) =>
        within(item).queryByRole('button', { name: 'Edit role' }) !== null &&
        item.textContent.includes('Test')
    );
  if (!row) throw new Error('tagged permission row missing');
  const scrollIntoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
  await user.click(within(row).getByRole('button', { name: 'Edit role' }));

  const name = screen.getByRole('textbox', { name: 'Role name' });
  expect(name).toHaveValue('Test');
  expect(name).toHaveFocus();
  expect(scrollIntoView).toHaveBeenCalled();
  scrollIntoView.mockRestore();
});

test('opens a role editor for a power level that no permission currently uses', async () => {
  core.session = { user_id: '@admin:example.org' };
  core.roomPowerLevels.mockResolvedValue(base);
  core.roomStateEvent.mockResolvedValue({});

  const user = userEvent.setup();
  render(RoomPermissionsSettings, { room, permissions });
  await user.click(await screen.findByRole('button', { name: 'Add role' }));

  expect(screen.getByLabelText('Power level')).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Role name' })).toBeInTheDocument();
  expect(screen.getByRole('textbox', { name: 'Icon' })).toBeInTheDocument();
});

test('a space applies its levels to the rooms below it that you can edit', async () => {
  core.session = { user_id: '@admin:example.org' };
  extraRooms.push({ room_id: '!room:example.org', state: 'joined', space_children: [] });
  const spaceLevels = { ...base, invite: 50 };
  core.roomPowerLevels.mockImplementation((roomId: string) =>
    Promise.resolve(roomId === space.room_id ? spaceLevels : { ...base, users: {} })
  );
  core.roomPermissions.mockResolvedValue(permissions);
  core.roomStateEvent.mockResolvedValue(null);
  core.sendStateEvent.mockClear();

  const user = userEvent.setup();
  render(RoomPermissionsSettings, { room: space as RoomSummary, permissions });
  expect(await screen.findByText(/Apply to 1 room/)).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Apply' }));
  await user.click(
    within(await screen.findByRole('dialog')).getByRole('button', { name: 'Apply' })
  );

  expect(await screen.findByText(/Updated 1 room, 0 skipped\./)).toBeInTheDocument();
  expect(core.sendStateEvent).toHaveBeenCalledWith(
    '!room:example.org',
    'm.room.power_levels',
    '',
    expect.objectContaining({ invite: 50 })
  );
});
