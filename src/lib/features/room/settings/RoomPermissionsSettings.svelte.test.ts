// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import type {
  PowerLevelLocation,
  PowerLevelTagView,
  RoomPermissionsView,
  RoomPowerLevelsView,
  RoomSummary,
} from '#src/generated/protocol';

type Tags = Record<string, PowerLevelTagView>;

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
  roomStateEvent: vi.fn<(roomId: string, eventType: string) => Promise<unknown>>(() =>
    Promise.resolve(null)
  ),
  roomPermissions: vi.fn<(roomId: string) => Promise<RoomPermissionsView>>(),
  sendStateEvent:
    vi.fn<
      (roomId: string, eventType: string, stateKey: string, content: unknown) => Promise<void>
    >(),
  powerLevelTags: vi.fn<(roomId: string) => Promise<Tags>>(() => Promise.resolve({})),
  setPowerLevelTag:
    vi.fn<(roomId: string, level: number, tag: PowerLevelTagView | null) => Promise<Tags>>(),
  setPowerLevel:
    vi.fn<
      (
        roomId: string,
        levels: RoomPowerLevelsView | null,
        location: PowerLevelLocation,
        level: number
      ) => Promise<RoomPowerLevelsView>
    >(),
  syncPowerLevelsFromSpace:
    vi.fn<
      (
        roomId: string,
        spaceId: string,
        levels: RoomPowerLevelsView | null
      ) => Promise<{ levels: RoomPowerLevelsView; tags: Tags }>
    >(),
  syncChildPowerLevels:
    vi.fn<(spaceId: string, childIds: string[]) => Promise<{ updated: number; skipped: number }>>(),
});

import RoomPermissionsSettings from './RoomPermissionsSettings.svelte';
import { FOUNDER_POWER_LEVEL } from '../members/power-tags';

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

test('syncing hands the space to the core and shows what it wrote', async () => {
  core.session = { user_id: '@admin:example.org' };
  core.roomPowerLevels.mockResolvedValue(base);
  core.syncPowerLevelsFromSpace.mockResolvedValue({
    levels: { ...base, ban: 75 },
    tags: { '50': { name: 'Moderator', color: null, icon: null } },
  });

  const user = userEvent.setup();
  render(RoomPermissionsSettings, { room, permissions });
  expect(await screen.findByText(/Sync with Guild/)).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Sync' }));
  await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Sync' }));

  await vi.waitFor(() => {
    expect(core.syncPowerLevelsFromSpace).toHaveBeenCalledWith(
      '!room:example.org',
      '!space:example.org',
      base
    );
  });
  expect(await screen.findByText('Moderator (50)')).toBeInTheDocument();
});

test('saves a role emoji with its name and colour', async () => {
  core.session = { user_id: '@admin:example.org' };
  core.roomPowerLevels.mockResolvedValue(base);
  core.powerLevelTags.mockResolvedValue({
    '50': { name: 'Sentinel', color: '#ff0000', icon: null },
  });
  core.setPowerLevelTag.mockResolvedValue({});

  const user = userEvent.setup();
  render(RoomPermissionsSettings, { room, permissions });
  const row = within((await screen.findByText('Sentinel (50)')).closest('li') ?? document.body);
  await user.click(row.getByRole('button', { name: 'Edit role' }));
  await user.type(screen.getByRole('textbox', { name: 'Icon' }), '🛡️{Enter}');

  await vi.waitFor(() => {
    expect(core.setPowerLevelTag).toHaveBeenCalledWith('!room:example.org', 50, {
      name: 'Sentinel',
      color: '#ff0000',
      icon: '🛡️',
    });
  });
});

test.each([
  [undefined, true],
  [100, false],
])('role editing follows the role-tag event level (%s)', async (tagsLevel, allowed) => {
  core.session = { user_id: '@mod:example.org' };
  core.roomPowerLevels.mockResolvedValue({
    ...base,
    events: tagsLevel === undefined ? {} : { 'in.cinny.room.power_level_tags': tagsLevel },
  });
  core.powerLevelTags.mockResolvedValue({ '50': { name: 'Sentinel', color: null, icon: null } });

  render(RoomPermissionsSettings, {
    room,
    permissions: { own_power_level: 50, can_change_power_levels: false } as RoomPermissionsView,
  });
  const [label] = await screen.findAllByText('Sentinel (50)');
  const row = within(label.closest('li') ?? document.body);

  expect(row.queryByRole('button', { name: 'Edit role' }) !== null).toBe(allowed);
  expect(screen.queryByRole('button', { name: 'Add role' }) !== null).toBe(allowed);
});

test('lets a founder add colour and an icon to the founder role', async () => {
  core.session = { user_id: '@admin:example.org' };
  core.roomPowerLevels.mockResolvedValue(base);
  core.powerLevelTags.mockResolvedValue({});
  const founderTag = { name: 'Founder', color: '#ff0000', icon: '👑' };
  core.setPowerLevelTag.mockResolvedValue({ [FOUNDER_POWER_LEVEL]: founderTag });

  const user = userEvent.setup();
  render(RoomPermissionsSettings, {
    room,
    permissions: { ...permissions, own_power_level: FOUNDER_POWER_LEVEL },
  });
  const founderRow = await screen.findByText(/^Founder$/);
  await user.click(
    within(founderRow.closest('li') ?? document.body).getByRole('button', { name: 'Edit role' })
  );
  await user.type(screen.getByRole('textbox', { name: 'Icon' }), '👑');
  await user.type(screen.getByRole('textbox', { name: 'Role colour' }), '#ff0000{Enter}');

  expect(core.setPowerLevelTag).toHaveBeenCalledWith(
    '!room:example.org',
    FOUNDER_POWER_LEVEL,
    founderTag
  );

  const row = founderRow.closest('li') ?? document.body;
  expect(within(row).getByText('👑')).toBeInTheDocument();
  expect(row.querySelector('.role-swatch')).toHaveStyle({ backgroundColor: '#ff0000' });
  await user.click(within(row).getByRole('button', { name: 'Edit role' }));
  expect(screen.getByRole('textbox', { name: 'Icon' })).toHaveValue('👑');
  expect(screen.getByRole('textbox', { name: 'Role colour' })).toHaveValue('#ff0000');
});

test('uses tagged default roles in permission controls and opens their editor', async () => {
  core.session = { user_id: '@admin:example.org' };
  core.roomPowerLevels.mockResolvedValue(base);
  core.powerLevelTags.mockResolvedValue({ '0': { name: 'Test', color: null, icon: null } });

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
  core.powerLevelTags.mockResolvedValue({});

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
  core.roomPowerLevels.mockResolvedValue(base);
  core.syncChildPowerLevels.mockResolvedValue({ updated: 1, skipped: 0 });

  const user = userEvent.setup();
  render(RoomPermissionsSettings, { room: space as RoomSummary, permissions });
  expect(await screen.findByText(/Apply to 1 room/)).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Apply' }));
  await user.click(
    within(await screen.findByRole('dialog')).getByRole('button', { name: 'Apply' })
  );

  expect(await screen.findByText(/Updated 1 room, 0 skipped\./)).toBeInTheDocument();
  expect(core.syncChildPowerLevels).toHaveBeenCalledWith('!space:example.org', [
    '!room:example.org',
  ]);
});

test('sets the level from which members stay listed whatever their presence (#497)', async () => {
  core.session = { user_id: '@admin:example.org' };
  core.roomPowerLevels.mockResolvedValue(base);
  const setMemberListThreshold = vi
    .fn<(roomId: string, level: number | null) => Promise<void>>()
    .mockResolvedValue(undefined);
  Object.assign(core, { setMemberListThreshold });

  const user = userEvent.setup();
  render(RoomPermissionsSettings, { room, permissions });
  const select = await screen.findByRole('button', { name: 'Always list' });
  expect(select).toHaveTextContent('Anyone above Member');

  await user.click(select);
  await user.click(await screen.findByRole('option', { name: 'Moderator and above' }));

  expect(setMemberListThreshold).toHaveBeenCalledWith('!room:example.org', 50);
  expect(select).toHaveTextContent('Moderator and above');
});
