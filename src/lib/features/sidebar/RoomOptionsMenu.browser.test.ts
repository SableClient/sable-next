import { render } from 'vitest-browser-svelte';
import { page } from 'vitest/browser';
import { expect, test, vi } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { createCoreStub } from '#lib/core/__mocks__/context.js';
import { withCounts } from '#lib/rooms/summary-fixtures.js';

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
  unread: 0,
  notifying: 0,
  highlight: 0,
  marked_unread: false,
  latest_event: null,
});

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

    const itemRole = width >= 768 ? 'menuitem' : 'menuitemradio';
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
    await page.getByRole(itemRole, { name: 'All messages', exact: true }).click();

    await vi.waitFor(() => {
      expect(setRoomNotificationMode).toHaveBeenCalledWith({ room_id: '!room', mode: 'all' });
    });
  }
);
