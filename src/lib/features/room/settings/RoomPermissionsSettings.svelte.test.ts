// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type {
  RoomPermissionsView,
  RoomPowerLevelsView,
  RoomSummary,
} from '#src/generated/protocol';

const { pageState, space } = vi.hoisted(() => ({
  pageState: {} as Record<string, unknown>,
  space: {
    room_id: '!space:example.org',
    name: 'Guild',
    is_space: true,
    state: 'joined',
    space_children: [{ room_id: '!room:example.org' }],
  },
}));

vi.mock('#lib/core/context.js');
vi.mock('$app/state', () => ({
  page: { url: { pathname: '/rooms' }, params: {}, state: pageState },
}));
vi.mock('$app/navigation', () => ({
  goto: (_href: string, options?: { state?: Record<string, unknown> }) => {
    Object.assign(pageState, options?.state);
    return Promise.resolve();
  },
}));

vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  useRoomList: () => ({
    rooms: [space],
    byId: (id: string) => (id === space.room_id ? space : undefined),
  }),
}));

import { core as baseCore } from '#lib/core/__mocks__/context.js';

const core = Object.assign(baseCore, {
  roomPowerLevels: vi.fn<(roomId: string) => Promise<RoomPowerLevelsView>>(),
  roomStateEvent: vi.fn<(roomId: string, eventType: string) => Promise<unknown>>(),
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
  document.body.replaceChildren();
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

  const instance = mount(RoomPermissionsSettings, {
    target: document.body,
    props: { room, permissions },
  });
  await vi.waitFor(() => {
    expect(document.body.textContent).toContain('Sync with Guild');
  });

  [...document.querySelectorAll<HTMLButtonElement>('.row-control button')]
    .find((button) => button.textContent.trim() === 'Sync')
    ?.click();
  await tick();
  [...document.querySelectorAll<HTMLButtonElement>('[role="dialog"] button')]
    .find((button) => button.textContent.trim() === 'Sync')
    ?.click();

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

  await unmount(instance);
});

test('saves a role emoji with its name and colour', async () => {
  core.session = { user_id: '@admin:example.org' };
  core.roomPowerLevels.mockResolvedValue(base);
  core.roomStateEvent.mockResolvedValue({
    '50': { name: 'Sentinel', color: '#ff0000' },
  });
  core.sendStateEvent.mockResolvedValue(undefined);

  const instance = mount(RoomPermissionsSettings, {
    target: document.body,
    props: { room, permissions },
  });
  await vi.waitFor(() => {
    expect(document.querySelector('.role-chip')?.textContent).toContain('Sentinel');
  });

  const row = document.querySelector('.role-chip')?.closest('li');
  row?.querySelector<HTMLButtonElement>('button[aria-label="Edit role"]')?.click();
  await tick();

  const icon = document.querySelector<HTMLInputElement>('#room-perm-role-icon');
  if (!icon) throw new Error('role emoji input missing');
  icon.value = '🛡️';
  icon.dispatchEvent(new Event('input', { bubbles: true }));
  document
    .querySelector<HTMLFormElement>('.settings-form')
    ?.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));

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
  await unmount(instance);
});

test('uses tagged default roles in permission controls and opens their editor', async () => {
  core.session = { user_id: '@admin:example.org' };
  core.roomPowerLevels.mockResolvedValue(base);
  core.roomStateEvent.mockResolvedValue({ '0': { name: 'Test' } });

  const instance = mount(RoomPermissionsSettings, {
    target: document.body,
    props: { room, permissions },
  });
  await vi.waitFor(() => {
    expect(document.querySelector('button[aria-label="Invite"]')?.textContent).toContain('Test');
  });

  const row = [...document.querySelectorAll('li')].find((item) =>
    item.textContent.includes('Test')
  );
  if (!row) throw new Error('tagged permission row missing');
  const edit = row.querySelector<HTMLButtonElement>('button[aria-label="Edit role"]');
  if (!edit) throw new Error('role edit button missing');
  const scrollIntoView = vi.spyOn(HTMLElement.prototype, 'scrollIntoView');
  edit.click();
  await tick();

  const name = document.querySelector<HTMLInputElement>('#room-perm-role-name');
  expect(name?.value).toBe('Test');
  expect(document.activeElement).toBe(name);
  expect(scrollIntoView).toHaveBeenCalled();
  scrollIntoView.mockRestore();
  await unmount(instance);
});

test('opens a role editor for a power level that no permission currently uses', async () => {
  core.session = { user_id: '@admin:example.org' };
  core.roomPowerLevels.mockResolvedValue(base);
  core.roomStateEvent.mockResolvedValue({});

  const instance = mount(RoomPermissionsSettings, {
    target: document.body,
    props: { room, permissions },
  });
  await vi.waitFor(() => {
    expect(document.body.textContent).toContain('Add role');
  });
  [...document.querySelectorAll<HTMLButtonElement>('button')]
    .find((button) => button.textContent.trim() === 'Add role')
    ?.click();
  await tick();

  expect(document.querySelector('#room-perm-role-level')).not.toBeNull();
  expect(document.querySelector('#room-perm-role-name')).not.toBeNull();
  expect(document.querySelector('#room-perm-role-icon')).not.toBeNull();
  await unmount(instance);
});
