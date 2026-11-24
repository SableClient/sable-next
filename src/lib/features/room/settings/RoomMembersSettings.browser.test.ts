import { expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';
import type { MemberView, RoomListItemView, RoomPermissionsView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js', async () => {
  const mock = await import('#lib/core/__mocks__/context.js');
  return { useCoreClient: () => mock.core, provideCoreClient: vi.fn() };
});
vi.mock('#lib/rooms/presence.svelte.js', () => ({
  usePresenceStore: () => ({ get: () => null, peek: () => null }),
}));
vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  useRoomList: () => ({ roomSpaces: () => undefined }),
}));
import { core } from '#lib/core/__mocks__/context.js';
import RoomMembersSettings from './RoomMembersSettings.svelte';

const member = (id: string, name: string, powerLevel: number): MemberView => ({
  user_id: id,
  display_name: name,
  real_name: name,
  real_avatar_url: null,
  avatar_url: null,
  power_level: powerLevel,
  membership: 'join',
  member_ts: null,
  kicked: false,
  service: false,
});
test('the member settings fit a phone width', async () => {
  await page.viewport(393, 852);
  Object.assign(core.rpc.members, {
    list: vi.fn(() =>
      Promise.resolve([
        member('@alice:example.org', 'Alice', 100),
        member('@bot:example.org', 'Bot', 0),
        member('@moderation:example.org', 'Moderation bot [@ to ping mods]', 0),
      ])
    ),
    powerLevelTags: vi.fn(() => Promise.resolve({})),
  });
  Object.assign(core.rpc.account, {
    searchUserDirectory: vi.fn(() => Promise.resolve({ limited: false, results: [] })),
  });
  const perms = {
    own_power_level: 100,
    can_post: true,
    can_react: true,
    can_redact_own: true,
    can_redact_others: true,
    can_invite: true,
    can_kick: true,
    can_ban: true,
    can_change_settings: true,
    can_pin: true,
    can_change_join_rule: true,
    can_change_power_levels: true,
    can_manage_children: true,
  } as RoomPermissionsView;
  const { container } = await render(RoomMembersSettings, {
    room: { room_id: '!room:example.org' } as RoomListItemView,
    permissions: perms,
  });
  container.style.cssText = 'width:361px;margin:0 16px';
  await expect.poll(() => container.textContent.includes('Bot')).toBe(true);
  await expect.poll(() => container.scrollWidth).toBeLessThanOrEqual(container.clientWidth);
});
