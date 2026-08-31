// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { MemberView } from '#src/generated/MemberView';
import type { RoomPermissionsView } from '#src/generated/RoomPermissionsView';
import type { RoomSummary } from '#src/generated/RoomSummary';

const core = vi.hoisted(() => {
  const stub = {
    roomMembers: vi.fn<() => Promise<MemberView[]>>(),
    kickUser: vi.fn<(roomId: string, userId: string, reason?: string | null) => Promise<void>>(),
    banUser: vi.fn<(roomId: string, userId: string, reason?: string | null) => Promise<void>>(),
    unbanUser: vi.fn<() => Promise<void>>(),
    setUserPowerLevel: vi.fn<() => Promise<void>>(),
  };

  return Object.assign(stub, { commands: stub });
});

vi.mock('#lib/core/context.js', () => ({
  useCoreClient: () => core,
}));

vi.mock('#lib/rooms/presence.svelte.js', () => ({
  usePresenceStore: () => ({ get: () => null }),
}));

import RoomMembersSettings from './RoomMembersSettings.svelte';

const alice: MemberView = {
  user_id: '@alice:example.org',
  display_name: 'Alice',
  avatar_url: null,
  power_level: 0,
  membership: 'join',
  member_ts: null,
  kicked: false,
};

const room: RoomSummary = { room_id: '!room:example.org' } as RoomSummary;

const permissions: RoomPermissionsView = {
  own_power_level: 100,
  can_post: true,
  can_redact_others: false,
  can_invite: false,
  can_kick: true,
  can_ban: true,
  can_change_settings: false,
  can_pin: false,
  can_change_join_rule: false,
  can_change_power_levels: false,
  can_manage_children: false,
};

afterEach(() => {
  document.body.replaceChildren();
});

test('collects an optional reason before kicking a member', async () => {
  core.roomMembers.mockResolvedValue([alice]);
  core.kickUser.mockResolvedValue(undefined);
  const instance = mount(RoomMembersSettings, {
    target: document.body,
    props: { room, permissions },
  });
  await vi.waitFor(() => {
    expect(document.querySelector('.settings-row')).not.toBeNull();
  });

  document.querySelectorAll<HTMLButtonElement>('.settings-row-control button').forEach((button) => {
    if (button.textContent.trim() === 'Remove from room') button.click();
  });
  await tick();

  const reasonInput = document.querySelector<HTMLInputElement>('.moderation input');
  if (!reasonInput) throw new Error('reason input missing');
  reasonInput.value = 'spamming links';
  reasonInput.dispatchEvent(new Event('input', { bubbles: true }));
  await tick();

  document.querySelector<HTMLButtonElement>('.moderation-actions .sable-button-danger')?.click();
  await vi.waitFor(() => {
    expect(core.kickUser).toHaveBeenCalledWith(
      '!room:example.org',
      '@alice:example.org',
      'spamming links'
    );
  });

  await unmount(instance);
});

test('sends no reason when the moderation reason is left blank', async () => {
  core.roomMembers.mockResolvedValue([alice]);
  core.banUser.mockResolvedValue(undefined);
  const instance = mount(RoomMembersSettings, {
    target: document.body,
    props: { room, permissions },
  });
  await vi.waitFor(() => {
    expect(document.querySelector('.settings-row')).not.toBeNull();
  });

  document.querySelectorAll<HTMLButtonElement>('.settings-row-control button').forEach((button) => {
    if (button.textContent.trim() === 'Ban from room') button.click();
  });
  await tick();

  document.querySelector<HTMLButtonElement>('.moderation-actions .sable-button-danger')?.click();
  await vi.waitFor(() => {
    expect(core.banUser).toHaveBeenCalledWith('!room:example.org', '@alice:example.org', null);
  });

  await unmount(instance);
});
