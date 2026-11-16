// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import type {
  PowerLevelLocation,
  PowerLevelTagView,
  RoomPermissionsView,
  RoomPowerLevelsView,
  RoomListItemView,
} from '#src/generated/protocol';

type Tags = Record<string, PowerLevelTagView>;

const { space, extraRooms } = vi.hoisted(() => ({
  extraRooms: [] as { room_id: string; state: string; space_children: never[] }[],
  space: {
    room_id: '!space:example.org',
    name: 'Guild',
    room_kind: 'space',
    state: 'joined',
    space_children: [
      { room_id: '!room:example.org', via: [], order: null, origin_server_ts: 0, suggested: false },
    ],
  },
}));

vi.mock('#lib/core/context.js');
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));

vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  useRoomList: () => ({
    rooms: [space, ...extraRooms],
    byId: (id: string) => (id === space.room_id ? space : undefined),
    roomSpaces: (id: string) => roomSpacesLookup([space, ...extraRooms] as never)(id),
  }),
}));

import { roomSpacesLookup } from '#lib/test-support/room-spaces.js';
import { core as baseCore } from '#lib/core/__mocks__/context.js';

const core = baseCore;
Object.assign(core.rpc.members, {
  powerLevels: vi.fn<(params: { room_id: string }) => Promise<RoomPowerLevelsView>>(),
  permissions: vi.fn<(params: { room_id: string }) => Promise<RoomPermissionsView>>(),
  powerLevelTags: vi.fn<(params: { room_id: string }) => Promise<Tags>>(() => Promise.resolve({})),
  setPowerLevelTag:
    vi.fn<
      (params: { room_id: string; level: number; tag: PowerLevelTagView | null }) => Promise<Tags>
    >(),
  setPowerLevel:
    vi.fn<
      (params: {
        room_id: string;
        levels: RoomPowerLevelsView | null;
        location: PowerLevelLocation;
        level: number;
      }) => Promise<RoomPowerLevelsView>
    >(),
  syncPowerLevelsFromSpace:
    vi.fn<
      (params: {
        room_id: string;
        space_id: string;
        levels: RoomPowerLevelsView | null;
      }) => Promise<{ levels: RoomPowerLevelsView; tags: Tags }>
    >(),
  syncChildPowerLevels:
    vi.fn<
      (params: {
        space_id: string;
        child_ids: string[];
      }) => Promise<{ updated: number; skipped: number }>
    >(),
});
Object.assign(core.rpc.room_state, {
  event: vi.fn<(roomId: string, eventType: string) => Promise<unknown>>(() =>
    Promise.resolve(null)
  ),
  sendEvent:
    vi.fn<
      (roomId: string, eventType: string, stateKey: string, content: unknown) => Promise<void>
    >(),
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

const room = { room_id: '!room:example.org', room_kind: 'text' } as RoomListItemView;

const permissions = {
  own_power_level: 100,
  can_change_power_levels: true,
} as RoomPermissionsView;

afterEach(() => {
  extraRooms.length = 0;
});

test('syncing hands the space to the core and shows what it wrote', async () => {
  core.session = { user_id: '@admin:example.org' };
  core.rpc.members.powerLevels.mockResolvedValue(base);
  core.rpc.members.syncPowerLevelsFromSpace.mockResolvedValue({
    levels: { ...base, ban: 75 },
    tags: { '50': { name: 'Moderator', color: null, icon: null } },
  });

  const user = userEvent.setup();
  render(RoomPermissionsSettings, { room, permissions });
  expect(await screen.findByText(/Sync with Guild/)).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Sync' }));
  await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Sync' }));

  await vi.waitFor(() => {
    expect(core.rpc.members.syncPowerLevelsFromSpace).toHaveBeenCalledWith({
      room_id: '!room:example.org',
      space_id: '!space:example.org',
      levels: base,
    });
  });
  expect(await screen.findByText('Moderator (50)')).toBeInTheDocument();
});

test('saves a role emoji with its name and colour', async () => {
  core.session = { user_id: '@admin:example.org' };
  core.rpc.members.powerLevels.mockResolvedValue(base);
  core.rpc.members.powerLevelTags.mockResolvedValue({
    '50': { name: 'Sentinel', color: '#ff0000', icon: null },
  });
  core.rpc.members.setPowerLevelTag.mockResolvedValue({});

  const user = userEvent.setup();
  render(RoomPermissionsSettings, { room, permissions });
  const row = within((await screen.findByText('Sentinel (50)')).closest('li') ?? document.body);
  await user.click(row.getByRole('button', { name: 'Edit role' }));
  await user.type(screen.getByRole('textbox', { name: 'Icon' }), '🛡️{Enter}');

  await vi.waitFor(() => {
    expect(core.rpc.members.setPowerLevelTag).toHaveBeenCalledWith({
      room_id: '!room:example.org',
      level: 50,
      tag: { name: 'Sentinel', color: '#ff0000', icon: '🛡️' },
    });
  });
});

test.each([
  [undefined, true],
  [100, false],
])('role editing follows the role-tag event level (%s)', async (tagsLevel, allowed) => {
  core.session = { user_id: '@mod:example.org' };
  core.rpc.members.powerLevels.mockResolvedValue({
    ...base,
    events: tagsLevel === undefined ? {} : { 'in.cinny.room.power_level_tags': tagsLevel },
  });
  core.rpc.members.powerLevelTags.mockResolvedValue({
    '50': { name: 'Sentinel', color: null, icon: null },
  });

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
  core.rpc.members.powerLevels.mockResolvedValue(base);
  core.rpc.members.powerLevelTags.mockResolvedValue({});
  const founderTag = { name: 'Founder', color: '#ff0000', icon: '👑' };
  core.rpc.members.setPowerLevelTag.mockResolvedValue({ [FOUNDER_POWER_LEVEL]: founderTag });

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

  expect(core.rpc.members.setPowerLevelTag).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    level: FOUNDER_POWER_LEVEL,
    tag: founderTag,
  });

  const row = founderRow.closest('li') ?? document.body;
  expect(within(row).getByText('👑')).toBeInTheDocument();
  expect(row.querySelector('.role-swatch')).toHaveStyle({ backgroundColor: '#ff0000' });
  await user.click(within(row).getByRole('button', { name: 'Edit role' }));
  expect(screen.getByRole('textbox', { name: 'Icon' })).toHaveValue('👑');
  expect(screen.getByRole('textbox', { name: 'Role colour' })).toHaveValue('#ff0000');
});

test('uses tagged default roles in permission controls and opens their editor', async () => {
  core.session = { user_id: '@admin:example.org' };
  core.rpc.members.powerLevels.mockResolvedValue(base);
  core.rpc.members.powerLevelTags.mockResolvedValue({
    '0': { name: 'Test', color: null, icon: null },
  });

  const user = userEvent.setup();
  render(RoomPermissionsSettings, { room, permissions });
  await vi.waitFor(() => {
    expect(screen.getByRole('combobox', { name: 'Invite' })).toHaveTextContent('Test');
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
  core.rpc.members.powerLevels.mockResolvedValue(base);
  core.rpc.members.powerLevelTags.mockResolvedValue({});

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
  core.rpc.members.powerLevels.mockResolvedValue(base);
  core.rpc.members.syncChildPowerLevels.mockResolvedValue({ updated: 1, skipped: 0 });

  const user = userEvent.setup();
  render(RoomPermissionsSettings, { room: space as never, permissions });
  expect(await screen.findByText(/Apply to 1 room/)).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Apply' }));
  await user.click(
    within(await screen.findByRole('dialog')).getByRole('button', { name: 'Apply' })
  );

  expect(await screen.findByText(/Updated 1 room, 0 skipped\./)).toBeInTheDocument();
  expect(core.rpc.members.syncChildPowerLevels).toHaveBeenCalledWith({
    space_id: '!space:example.org',
    child_ids: ['!room:example.org'],
  });
});

test('sets the level from which members stay listed whatever their presence (#497)', async () => {
  core.session = { user_id: '@admin:example.org' };
  core.rpc.members.powerLevels.mockResolvedValue(base);
  const setMemberListThreshold = vi
    .fn<(params: { room_id: string; always_listed_from: number | null }) => Promise<null>>()
    .mockResolvedValue(null);
  Object.assign(core.rpc.room_state, { setMemberListThreshold });

  const user = userEvent.setup();
  render(RoomPermissionsSettings, { room, permissions });
  const select = await screen.findByRole('combobox', { name: 'Always list' });
  expect(select).toHaveTextContent('Anyone above Member');

  await user.click(select);
  await user.click(await screen.findByRole('option', { name: 'Moderator and above' }));

  expect(setMemberListThreshold).toHaveBeenCalledWith({
    room_id: '!room:example.org',
    always_listed_from: 50,
  });
  expect(select).toHaveTextContent('Moderator and above');
});
