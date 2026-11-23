import { afterEach, expect, test, vi } from 'vitest';
import { page, userEvent } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

import type { NotificationModeView, RoomListItemView } from '#src/generated/protocol';

import { roomNotifications, roomUnread } from '#lib/rooms/unread.js';
import { expectNoA11yViolations, ICONS_HIDDEN_BY_LAYOUT } from '#lib/test-support/a11y.js';
import { visit } from '#lib/test-support/app-state.js';
import { roomView } from '#lib/test-support/room-views.js';

const roomsFixture = vi.hoisted(() => {
  const fixture = {
    rooms: [] as RoomListItemView[],
    typingUsers: new Map<string, readonly string[]>(),
    warm: () => {},
    byId: (roomId: string | null) => fixture.rooms.find((room) => room.room_id === roomId),
    notificationOverride: () => null,
    notificationMode: (): NotificationModeView => 'all',
    mutedRoomIds: new Set<string>(),
    section: (key: string) => ({
      key,
      favourites: [],
      rooms: fixture.rooms.map((room) => room.room_id),
      subspaces: [],
      calendars: [],
      invites: [],
      unread: { unread: 0, notifying: 0, highlight: 0, marked: false },
      unread_rooms: [],
      descendants: [],
    }),
    quietRoomIds: new Set<string>(),
    unreadFor: (room: RoomListItemView) => roomUnread(room),
    badgeUnreadFor: (room: RoomListItemView) => roomUnread(room),
    notificationsFor: (room: RoomListItemView) => roomNotifications(room),
  };
  return fixture;
});

vi.mock('#lib/core/context.js', async () => {
  const mock = await import('#lib/core/__mocks__/context.js');
  return { useCoreClient: () => mock.core, provideCoreClient: vi.fn() };
});
vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('#lib/rooms/room-list.svelte.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('#lib/rooms/room-list.svelte.js')>()),
  useRoomList: () => roomsFixture,
}));
vi.mock('#lib/rooms/presence.svelte.js', async () => {
  const actual = await vi.importActual<typeof import('#lib/rooms/presence.svelte.js')>(
    '#lib/rooms/presence.svelte.js'
  );
  return { ...actual, usePresenceStore: () => ({ get: () => null, peek: () => null }) };
});

import { core } from '#lib/core/__mocks__/context.js';

import RoomNavHarness from './RoomNavHarness.test.svelte';

afterEach(async () => {
  visit('/');
  roomsFixture.rooms = [];
  await page.viewport(414, 800);
});

function room(overrides: Partial<RoomListItemView>): RoomListItemView {
  return roomView({
    supports_knock: true,
    supports_restricted: true,
    supports_knock_restricted: true,
    latest_event: {
      sender: null,
      own: false,
      sender_label: null,
      kind: 'text',
      body: 'hi',
      emotes: [],
      timestamp: 1,
      sending: false,
      event_id: null,
    },
    ...overrides,
  });
}

async function mountNav(props: { collapsed?: boolean; width?: number; height?: number } = {}) {
  Object.assign(core.rpc.notifications, {
    settings: vi.fn().mockResolvedValue({ mode: 'all', default: 'all' }),
  });
  await page.viewport(1280, 900);
  return render(RoomNavHarness, props);
}

test('collapsed room rows keep their unread badges inside the row', async () => {
  roomsFixture.rooms = [
    room({ room_id: '!a:example.org', name: 'General', unread: 4, notifying: 4, highlight: 1 }),
    room({ room_id: '!b:example.org', name: 'Random', unread: 12, notifying: 12 }),
    room({ room_id: '!c:example.org', name: 'Elsewhere', unread: 120, notifying: 120 }),
  ];
  await mountNav({ collapsed: true, width: 50 });

  await expect
    .poll(() => document.querySelectorAll('.room-list.collapsed .room-row .unread-badge').length)
    .toBeGreaterThan(0);
  const outside = [
    ...document.querySelectorAll('.room-list.collapsed .room-row .unread-badge'),
  ].filter((badge) => {
    const wrap = badge.closest('.room-row-wrap')?.getBoundingClientRect();
    const box = badge.getBoundingClientRect();
    return !wrap || box.left < wrap.left || box.right > wrap.right || box.top < wrap.top;
  });
  expect(outside).toHaveLength(0);
  await expectNoA11yViolations(document.body, { disableRules: ICONS_HIDDEN_BY_LAYOUT });
});

test('hovering a collapsed room keeps its avatar inside the row', async () => {
  roomsFixture.rooms = [room({ room_id: '!a:example.org', name: 'General' })];
  await mountNav({ collapsed: true, width: 50 });

  await expect
    .poll(() => document.querySelector('.room-list.collapsed .room-row .avatar-root'))
    .not.toBeNull();
  const row = document.querySelector<HTMLElement>('.room-list.collapsed .room-row');
  const avatar = row?.querySelector('.avatar-root');
  if (!row || !avatar) throw new Error('the collapsed room row is not rendered');
  const before = avatar.getBoundingClientRect();

  await userEvent.hover(row);
  const after = avatar.getBoundingClientRect();
  const box = row.getBoundingClientRect();
  expect(after.left).toBe(before.left);
  expect(after.left).toBeGreaterThanOrEqual(box.left);
  expect(after.right).toBeLessThanOrEqual(box.right);
});

test('the row options button toggles the shared menu and returns focus', async () => {
  roomsFixture.rooms = [room({ room_id: '!a:example.org', name: 'General' })];
  const screen = await mountNav();
  const wrap = () => {
    const node = [...document.querySelectorAll<HTMLElement>('.room-row-wrap')].find((candidate) =>
      candidate.textContent.includes('General')
    );
    if (!node) throw new Error('the General row is not rendered');
    return node;
  };
  await expect.poll(() => document.querySelector('.room-row-wrap')).not.toBeNull();
  await userEvent.hover(wrap());
  const trigger = screen.getByRole('button', { name: 'Room options', includeHidden: true });

  await userEvent.click(trigger);
  await expect.element(screen.getByRole('menu')).toBeVisible();
  await expect.element(trigger).toHaveAttribute('aria-expanded', 'true');
  await expectNoA11yViolations(document.body, { disableRules: ICONS_HIDDEN_BY_LAYOUT });

  await userEvent.click(trigger);
  await expect.poll(() => screen.getByRole('menu').elements().length).toBe(0);
  for (let frame = 0; frame < 20; frame += 1) {
    await new Promise((resolve) => requestAnimationFrame(resolve));
  }
  expect(screen.getByRole('menu').elements()).toHaveLength(0);

  trigger.element().focus();
  await userEvent.keyboard('{Enter}');
  await expect.element(screen.getByRole('menu')).toBeVisible();
  await userEvent.keyboard('{Escape}');
  await expect.poll(() => screen.getByRole('menu').elements().length).toBe(0);
  await expect.element(trigger).toHaveFocus();

  await userEvent.click(screen.getByText('General'), { button: 'right' });
  await expect.element(screen.getByRole('menu')).toBeVisible();
  await userEvent.keyboard('{Escape}');
});

test('the list options menu renders its checkable items (#1341)', async () => {
  roomsFixture.rooms = [room({ room_id: '!a:example.org', name: 'General' })];
  const screen = await mountNav();
  await userEvent.click(screen.getByRole('button', { name: 'List options' }));
  await expect
    .element(screen.getByRole('menuitemcheckbox', { name: 'Group favourites' }))
    .toBeVisible();
  await expectNoA11yViolations(document.body, { disableRules: ICONS_HIDDEN_BY_LAYOUT });
});

test('the room sort menu offers unread first and persists the choice', async () => {
  roomsFixture.rooms = [room({ room_id: '!a:example.org', name: 'General' })];
  const screen = await mountNav();
  await userEvent.click(screen.getByRole('button', { name: 'Sort rooms: Recent activity' }));
  await expect.element(screen.getByRole('menuitemradio', { name: 'Unread first' })).toBeVisible();
  await userEvent.click(screen.getByRole('menuitemradio', { name: 'Unread first' }));
  await expect
    .element(screen.getByRole('button', { name: 'Sort rooms: Unread first' }))
    .toBeVisible();
});

test('a long room list mounts only the rows near the viewport and follows the scroll', async () => {
  roomsFixture.rooms = Array.from({ length: 1000 }, (_, index) =>
    room({ room_id: `!r${index}:example.org`, name: `Room ${index}`, is_direct: true })
  );
  await mountNav({ height: 400 });
  const scroller = document.querySelector<HTMLElement>('.room-nav-content');
  if (!scroller) throw new Error('the room list scroller is not rendered');
  const rows = () => document.querySelectorAll('.room-list .room-row-wrap');

  await expect.poll(() => rows().length).toBeGreaterThan(0);
  expect(rows().length).toBeLessThan(100);
  expect(document.querySelector('[aria-posinset="1"]')?.getAttribute('aria-setsize')).toBe('1000');
  expect(document.body.textContent).not.toContain('Room 900');

  scroller.scrollTop = scroller.scrollHeight;
  await expect.poll(() => document.body.textContent).toContain('Room 999');
  expect(rows().length).toBeLessThan(100);
  expect(document.body.textContent).not.toContain('Room 5 ');
});

test('End moves focus to the last room of a windowed list', async () => {
  roomsFixture.rooms = Array.from({ length: 1000 }, (_, index) =>
    room({ room_id: `!r${index}:example.org`, name: `Room ${index}`, is_direct: true })
  );
  await mountNav({ height: 400 });
  const scroller = document.querySelector<HTMLElement>('.room-nav-content');
  if (!scroller) throw new Error('the room list scroller is not rendered');
  await expect.poll(() => document.querySelector('.room-row')).not.toBeNull();

  document.querySelector<HTMLElement>('.room-row')?.focus();
  await userEvent.keyboard('{End}');

  await expect.poll(() => document.activeElement?.getAttribute('aria-posinset')).toBe('1000');
});

function directRooms(
  count: number,
  overrides: (index: number) => Partial<RoomListItemView> = () => ({})
) {
  roomsFixture.rooms = Array.from({ length: count }, (_, index) =>
    room({
      room_id: `!r${String(index)}:example.org`,
      name: `Room ${String(index)}`,
      is_direct: true,
      ...overrides(index),
    })
  );
}

async function mountShortNav() {
  await mountNav({ height: 400 });
  const scroller = document.querySelector<HTMLElement>('.room-nav-content');
  if (!scroller) throw new Error('the room list scroller is not rendered');
  await expect.poll(() => document.querySelector('.room-row')).not.toBeNull();
  return scroller;
}

const rowTop = (name: string) => {
  const node = [...document.querySelectorAll<HTMLElement>('.room-row-wrap')].find((candidate) =>
    candidate.textContent.includes(name)
  );
  return node?.getBoundingClientRect().top;
};

const settle = () =>
  new Promise<void>((resolve) => {
    requestAnimationFrame(() => {
      requestAnimationFrame(() => {
        resolve();
      });
    });
  });

test('a tall row leaving the window keeps the scroll height and the rows below in place', async () => {
  directRooms(1000, (index) =>
    index === 3
      ? {
          room_kind: 'voice',
          call_participants: Array.from({ length: 8 }, (_, at) => `@p${String(at)}:example.org`),
        }
      : {}
  );
  const scroller = await mountShortNav();
  await expect
    .poll(() => document.querySelector('.call-participants, [class*="participant"]'))
    .not.toBeNull();
  await settle();
  const height = scroller.scrollHeight;

  scroller.scrollTop = 40 * 36;
  await expect.poll(() => rowTop('Room 3 ')).toBeUndefined();
  scroller.scrollTop = 0;
  await expect.poll(() => rowTop('Room 3 ')).toBeDefined();
  await settle();
  expect(scroller.scrollHeight).toBe(height);

  scroller.scrollTop = 600;
  await settle();
  const before = rowTop('Room 30');
  const total = scroller.scrollHeight;
  scroller.scrollTop = 600 + 40 * 36;
  await settle();
  scroller.scrollTop = 600;
  await settle();
  expect(scroller.scrollHeight).toBe(total);
  expect(rowTop('Room 30')).toBe(before);
});

test('scrolling up through rows taller than the estimate keeps the visible rows still', async () => {
  directRooms(1000, (index) => (index % 3 === 0 ? { topic: `Topic ${String(index)}` } : {}));
  const scroller = await mountShortNav();

  scroller.scrollTop = scroller.scrollHeight;
  await expect.poll(() => rowTop('Room 999')).toBeDefined();
  await settle();
  const topOf = (key: string) =>
    document.querySelector(`[data-row-key="${key}"]`)?.getBoundingClientRect().top;
  for (let step = 0; step < 40; step++) {
    const anchor = [...document.querySelectorAll<HTMLElement>('.room-list [data-row-key]')].find(
      (row) => row.getBoundingClientRect().top >= scroller.getBoundingClientRect().top
    );
    const key = anchor?.dataset.rowKey ?? '';
    const before = topOf(key) ?? 0;
    scroller.scrollTop -= 100;
    await settle();
    expect(Math.abs((topOf(key) ?? 0) - before - 100)).toBeLessThan(1);
  }
});

test('arrow keys walk past the initial window and back without losing focus', async () => {
  directRooms(1000);
  await mountShortNav();
  const rows = () => [...document.querySelectorAll<HTMLElement>('.room-row')];
  rows()[0].focus();

  for (let step = 0; step < 60; step++) {
    await userEvent.keyboard('{ArrowDown}');
    await expect
      .poll(() => document.activeElement?.getAttribute('aria-posinset'))
      .toBe(String(step + 2));
  }
  expect(document.activeElement?.textContent).toContain('Room 60');

  for (let step = 0; step < 60; step++) await userEvent.keyboard('{ArrowUp}');
  await expect.poll(() => document.activeElement?.getAttribute('aria-posinset')).toBe('1');
});

test('navigating to a room far down the list scrolls it into view', async () => {
  directRooms(1000);
  visit(`/direct/${encodeURIComponent('!r700:example.org')}`);
  const scroller = await mountShortNav();

  await expect.poll(() => document.querySelector('[aria-current="page"]')).not.toBeNull();
  await settle();
  const active = document.querySelector('[aria-current="page"]');
  const box = active?.getBoundingClientRect();
  const view = scroller.getBoundingClientRect();
  expect(box && box.top >= view.top && box.bottom <= view.bottom).toBe(true);
});
