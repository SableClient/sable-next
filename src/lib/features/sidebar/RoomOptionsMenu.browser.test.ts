import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { expect, test, vi } from 'vitest';
import { tick } from 'svelte';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { createCoreStub } from '#lib/core/__mocks__/context.js';
import { expectNoA11yViolations, ICONS_HIDDEN_BY_LAYOUT } from '#lib/test-support/a11y.js';
import { withCounts } from '#lib/rooms/summary-fixtures.js';
import { spaceNotifications } from '#lib/rooms/space-notifications.svelte.js';

import RoomOptionsMenuHarness from './RoomOptionsMenuHarness.test.svelte';

const currentRoom = withCounts({
  room_id: '!room',
  canonical_alias: null,
  name: 'Room',
  topic: null,
  topic_html: null,
  avatar_url: null,
  is_direct: false,
  direct_targets: [],
  join_rule: 'invite',
  tags: [],
  state: 'joined',
  encrypted: null,
  is_tombstoned: false,
  call_participants: [],
  screen_sharers: [],
  room_kind: 'text',
  supports_knock: false,
  supports_restricted: false,
  supports_knock_restricted: false,
  space_children: [],
  bridge: null,
  unread: 0,
  notifying: 0,
  highlight: 0,
  marked_unread: false,
  latest_event: null,
});

test.each([1280, 390])(
  'parent space loading keeps menu rows in place at width %i',
  async (width) => {
    await page.viewport(width, 900);
    let resolveParents!: (parents: { room_id: string; via: string[] }[]) => void;
    let resolvePreview!: (preview: { name: string }) => void;
    const parents = new Promise<{ room_id: string; via: string[] }[]>((resolve) => {
      resolveParents = resolve;
    });
    const preview = new Promise<{ name: string }>((resolve) => {
      resolvePreview = resolve;
    });
    const core = createCoreStub({
      rpc: {
        spaces: { unjoinedSpaceParents: vi.fn(() => parents) },
        rooms: { preview: vi.fn(() => preview) },
        members: { permissions: vi.fn().mockResolvedValue({ can_manage_children: false }) },
        notifications: { settings: vi.fn().mockResolvedValue({ room: null, default: 'mentions' }) },
      },
    }) as unknown as CoreClient;
    await render(RoomOptionsMenuHarness, {
      core,
      room: currentRoom,
      rooms: [currentRoom],
      registerRefresh: () => {},
    });
    await page.getByRole('button', { name: 'Room options' }).click();
    const join = page.getByRole('menuitem', { name: 'Join space', exact: true });
    await expect.element(join).toBeDisabled();
    const leave = page.getByRole('menuitem', { name: 'Leave room', exact: true });
    const before = leave.element().getBoundingClientRect().top;

    resolveParents([{ room_id: '!parent:example.org', via: ['example.org'] }]);
    await expect.element(join).toBeEnabled();
    resolvePreview({ name: 'Parent space' });
    await tick();
    await expect.poll(() => leave.element().getBoundingClientRect().top).toBe(before);

    if (width >= 768) await join.hover();
    else await join.click();
    await expect
      .element(page.getByRole('menuitem', { name: 'Join Parent space', exact: true }))
      .toBeVisible();
  }
);

test.each([1280, 390])(
  'opens notification settings and applies a mode at width %i',
  async (width) => {
    await page.viewport(width, 900);
    const setRoomNotificationMode = vi.fn().mockResolvedValue(null);
    const core = createCoreStub({
      rpc: {
        notifications: {
          settings: vi.fn().mockResolvedValue({ room: null, default: 'mentions' }),
          setRoomNotificationMode,
        },
        members: { permissions: vi.fn().mockResolvedValue({ can_manage_children: false }) },
      },
    }) as unknown as CoreClient;

    await render(RoomOptionsMenuHarness, {
      core,
      room: currentRoom,
      rooms: [currentRoom],
      registerRefresh: () => {},
    });

    await page.getByRole('button', { name: 'Room options' }).click();
    const notifications = page.getByRole('menuitem', { name: 'Notifications', exact: true });
    if (width >= 768) await notifications.hover();
    else await notifications.click();

    const itemRole = 'menuitemradio';
    for (const label of [
      'Default (Mentions and keywords)',
      'All messages',
      'Mentions and keywords',
      'Mentions only, no unread dot',
      'Mute',
    ]) {
      await expect.element(page.getByRole(itemRole, { name: label, exact: true })).toBeVisible();
    }
    await expect
      .element(page.getByRole(itemRole, { name: 'Default (Mentions and keywords)', exact: true }))
      .toHaveAttribute('aria-checked', 'true');
    await expectNoA11yViolations(document.body, { disableRules: ICONS_HIDDEN_BY_LAYOUT });
    await page.getByRole(itemRole, { name: 'All messages', exact: true }).click();

    await vi.waitFor(() => {
      expect(setRoomNotificationMode).toHaveBeenCalledWith({ room_id: '!room', mode: 'all' });
    });
  }
);

test('sets the space notification mode and moves the rooms that followed it', async () => {
  await page.viewport(1280, 900);
  const edge = (room_id: string) => ({
    room_id,
    via: [],
    order: null,
    origin_server_ts: 0,
    suggested: false,
  });
  const following = withCounts({
    ...currentRoom,
    room_id: '!following',
    notification: { room: 'all', default: 'mentions' },
  });
  const own = withCounts({
    ...currentRoom,
    room_id: '!own',
    notification: { room: 'mentions', default: 'mentions' },
  });
  const space = withCounts({
    ...currentRoom,
    room_id: '!space',
    name: 'Space',
    room_kind: 'space',
    space_children: [edge(following.room_id), edge(own.room_id)],
  });
  const settings = vi.fn();
  const setRoomsNotificationMode = vi.fn().mockResolvedValue(null);
  const setSpaceNotification = vi
    .fn()
    .mockResolvedValue({ spaces: [{ space_id: '!space', mode: 'mute' }], exempt_rooms: [] });
  const core = createCoreStub({
    rpc: {
      account: {
        spaceNotifications: vi
          .fn()
          .mockResolvedValue({ spaces: [{ space_id: '!space', mode: 'all' }], exempt_rooms: [] }),
        setSpaceNotification,
      },
      notifications: { settings, setRoomsNotificationMode },
      members: { permissions: vi.fn().mockResolvedValue({ can_manage_children: false }) },
    },
  }) as unknown as CoreClient;
  spaceNotifications.start(core);
  await vi.waitFor(() => {
    expect(spaceNotifications.modeOf('!space')).toBe('all');
  });

  await render(RoomOptionsMenuHarness, {
    core,
    room: space,
    rooms: [space, following, own],
    registerRefresh: () => {},
  });

  await page.getByRole('button', { name: 'Room options' }).click();
  await page.getByRole('menuitem', { name: 'Notifications', exact: true }).hover();
  await expect
    .element(page.getByRole('menuitemradio', { name: 'All messages', exact: true }))
    .toHaveAttribute('aria-checked', 'true');
  await page.getByRole('menuitemradio', { name: 'Mute', exact: true }).click();

  await vi.waitFor(() => {
    expect(setRoomsNotificationMode).toHaveBeenCalledWith({
      room_ids: ['!space', '!following'],
      mode: 'mute',
    });
  });
  expect(setSpaceNotification).toHaveBeenCalledWith({ space_id: '!space', mode: 'mute' });
  expect(settings).not.toHaveBeenCalled();
  spaceNotifications.stop();
});

test('a room carrying its space mode shows it as following the space', async () => {
  await page.viewport(1280, 900);
  const muted = withCounts({ ...currentRoom, notification: { room: 'mute', default: 'mentions' } });
  const space = withCounts({
    ...currentRoom,
    room_id: '!space',
    room_kind: 'space',
    space_children: [
      { room_id: muted.room_id, via: [], order: null, origin_server_ts: 0, suggested: false },
    ],
  });
  const setRoomNotificationMode = vi.fn().mockResolvedValue(null);
  const setSpaceNotificationExempt = vi
    .fn()
    .mockResolvedValue({ spaces: [{ space_id: '!space', mode: 'mute' }], exempt_rooms: ['!room'] });
  const core = createCoreStub({
    rpc: {
      account: {
        spaceNotifications: vi
          .fn()
          .mockResolvedValue({ spaces: [{ space_id: '!space', mode: 'mute' }], exempt_rooms: [] }),
        setSpaceNotificationExempt,
      },
      notifications: {
        settings: vi.fn().mockResolvedValue({ room: 'mute', default: 'mentions' }),
        setRoomNotificationMode,
      },
      members: { permissions: vi.fn().mockResolvedValue({ can_manage_children: false }) },
    },
  }) as unknown as CoreClient;
  spaceNotifications.start(core);
  await vi.waitFor(() => {
    expect(spaceNotifications.modeOf('!space')).toBe('mute');
  });

  await render(RoomOptionsMenuHarness, {
    core,
    room: muted,
    rooms: [space, muted],
    registerRefresh: () => {},
  });

  await page.getByRole('button', { name: 'Room options' }).click();
  await page.getByRole('menuitem', { name: 'Notifications', exact: true }).hover();
  await expect
    .element(page.getByRole('menuitemradio', { name: 'Space (Mute)', exact: true }))
    .toHaveAttribute('aria-checked', 'true');
  await expect
    .element(page.getByRole('menuitemradio', { name: 'Mute', exact: true }))
    .toHaveAttribute('aria-checked', 'false');
  await page
    .getByRole('menuitemradio', { name: 'Default (Mentions and keywords)', exact: true })
    .click();

  await vi.waitFor(() => {
    expect(setSpaceNotificationExempt).toHaveBeenCalledWith({ room_id: '!room', exempt: true });
  });
  expect(setRoomNotificationMode).toHaveBeenCalledWith({ room_id: '!room', mode: null });
  spaceNotifications.stop();
});

test('a muted space without a space mode shows as muted', async () => {
  await page.viewport(1280, 900);
  const space = withCounts({
    ...currentRoom,
    room_id: '!space',
    room_kind: 'space',
    notification: { room: 'mute', default: 'mentions' },
  });
  const core = createCoreStub({
    rpc: {
      account: { spaceNotifications: vi.fn().mockResolvedValue({ spaces: [], exempt_rooms: [] }) },
      members: { permissions: vi.fn().mockResolvedValue({ can_manage_children: false }) },
    },
  }) as unknown as CoreClient;
  spaceNotifications.start(core);

  await render(RoomOptionsMenuHarness, {
    core,
    room: space,
    rooms: [space],
    registerRefresh: () => {},
  });

  await page.getByRole('button', { name: 'Room options' }).click();
  await page.getByRole('menuitem', { name: 'Notifications', exact: true }).hover();
  await expect
    .element(page.getByRole('menuitemradio', { name: 'Mute', exact: true }))
    .toHaveAttribute('aria-checked', 'true');
  spaceNotifications.stop();
});
