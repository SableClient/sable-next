// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type {
  MemberView,
  RoomPermissionsView,
  RoomSummary,
  UserDirectoryEntryView,
} from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

import { core as baseCore } from '#lib/core/__mocks__/context.js';

const core = Object.assign(baseCore, {
  roomMembers: vi.fn<() => Promise<MemberView[]>>(),
  kickUser: vi.fn<(roomId: string, userId: string, reason?: string | null) => Promise<void>>(),
  banUser: vi.fn<(roomId: string, userId: string, reason?: string | null) => Promise<void>>(),
  unbanUser: vi.fn<() => Promise<void>>(),
  setUserPowerLevel: vi.fn<() => Promise<void>>(),
  inviteUser: vi.fn<(roomId: string, userId: string) => Promise<void>>(),
  searchUserDirectory:
    vi.fn<() => Promise<{ limited: boolean; results: UserDirectoryEntryView[] }>>(),
});

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
  service: false,
};

const room: RoomSummary = { room_id: '!room:example.org' } as RoomSummary;

const permissions: RoomPermissionsView = {
  own_power_level: 100,
  can_post: true,
  can_react: true,
  can_redact_own: true,
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
    expect(document.querySelector('.setting-row')).not.toBeNull();
  });

  document.querySelectorAll<HTMLButtonElement>('.row-control button').forEach((button) => {
    if (button.textContent.trim() === 'Remove from room') button.click();
  });
  await tick();

  const reasonInput = document.querySelector<HTMLInputElement>('.moderation input');
  if (!reasonInput) throw new Error('reason input missing');
  reasonInput.value = 'spamming links';
  reasonInput.dispatchEvent(new Event('input', { bubbles: true }));
  await tick();

  document.querySelector<HTMLButtonElement>('.moderation-actions .btn-danger')?.click();
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
    expect(document.querySelector('.setting-row')).not.toBeNull();
  });

  document.querySelectorAll<HTMLButtonElement>('.row-control button').forEach((button) => {
    if (button.textContent.trim() === 'Ban from room') button.click();
  });
  await tick();

  document.querySelector<HTMLButtonElement>('.moderation-actions .btn-danger')?.click();
  await vi.waitFor(() => {
    expect(core.banUser).toHaveBeenCalledWith('!room:example.org', '@alice:example.org', null);
  });

  await unmount(instance);
});

test('searches the directory and invites from the members list', async () => {
  core.roomMembers.mockResolvedValue([alice]);
  core.searchUserDirectory.mockResolvedValue({
    limited: false,
    results: [
      { user_id: '@alice:example.org', display_name: 'Alice', avatar_url: null },
      { user_id: '@bob:example.org', display_name: 'Bob', avatar_url: null },
    ],
  });
  core.inviteUser.mockResolvedValue(undefined);
  const instance = mount(RoomMembersSettings, {
    target: document.body,
    props: { room, permissions: { ...permissions, can_invite: true } },
  });
  await vi.waitFor(() => {
    expect(document.querySelector('.setting-row')).not.toBeNull();
  });

  const input = document.querySelector<HTMLInputElement>('.search input');
  if (!input) throw new Error('search input missing');
  input.value = 'bo';
  input.dispatchEvent(new Event('input', { bubbles: true }));

  const inviteSection = () =>
    document.querySelector('[aria-labelledby="room-settings-members-invite"]');
  await vi.waitFor(() => {
    expect(core.searchUserDirectory).toHaveBeenCalledWith('bo', 10);
    expect(inviteSection()?.querySelectorAll('.setting-row')).toHaveLength(1);
  });
  expect(inviteSection()?.textContent).toContain('@bob:example.org');
  expect(inviteSection()?.textContent).not.toContain('@alice:example.org');

  inviteSection()?.querySelector<HTMLButtonElement>('.row-control button')?.click();
  await vi.waitFor(() => {
    expect(core.inviteUser).toHaveBeenCalledWith('!room:example.org', '@bob:example.org');
    expect(inviteSection()?.querySelector('.row-control button')).toBeNull();
    expect(inviteSection()?.textContent).toContain('Invited');
  });

  await unmount(instance);
});

test('offers a typed user id the directory does not know', async () => {
  core.roomMembers.mockResolvedValue([alice]);
  core.searchUserDirectory.mockResolvedValue({ limited: false, results: [] });
  const instance = mount(RoomMembersSettings, {
    target: document.body,
    props: { room, permissions: { ...permissions, can_invite: true } },
  });
  await vi.waitFor(() => {
    expect(document.querySelector('.setting-row')).not.toBeNull();
  });

  const input = document.querySelector<HTMLInputElement>('.search input');
  if (!input) throw new Error('search input missing');
  input.value = '@carol:elsewhere.org';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await tick();

  const section = document.querySelector('[aria-labelledby="room-settings-members-invite"]');
  expect(section?.textContent).toContain('@carol:elsewhere.org');

  await unmount(instance);
});

test('offers no invite without the permission', async () => {
  core.roomMembers.mockResolvedValue([alice]);
  const instance = mount(RoomMembersSettings, {
    target: document.body,
    props: { room, permissions },
  });
  await vi.waitFor(() => {
    expect(document.querySelector('.setting-row')).not.toBeNull();
  });

  expect(document.querySelector('.search button')).toBeNull();
  const input = document.querySelector<HTMLInputElement>('.search input');
  if (!input) throw new Error('search input missing');
  input.value = '@carol:elsewhere.org';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await tick();
  expect(document.querySelector('[aria-labelledby="room-settings-members-invite"]')).toBeNull();

  await unmount(instance);
});

async function press(element: Element): Promise<void> {
  element.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerType: 'mouse',
      button: 0,
      isPrimary: true,
    })
  );
  element.dispatchEvent(
    new PointerEvent('pointerup', { bubbles: true, cancelable: true, pointerType: 'mouse' })
  );
  element.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, detail: 1 }));
  await tick();
}

test('keeps a changed power level when the reload still returns the old one', async () => {
  const bob: MemberView = { ...alice, user_id: '@bob:example.org', display_name: 'Bob' };
  core.roomMembers.mockResolvedValue([alice, bob]);
  core.setUserPowerLevel.mockResolvedValue(undefined);
  const instance = mount(RoomMembersSettings, {
    target: document.body,
    props: { room, permissions: { ...permissions, can_change_power_levels: true } },
  });
  const names = () =>
    Array.from(document.querySelectorAll('.setting-row'), (row) =>
      row.textContent.includes('Bob') ? 'Bob' : 'Alice'
    );
  await vi.waitFor(() => {
    expect(names()).toEqual(['Alice', 'Bob']);
  });

  const triggers = document.querySelectorAll<HTMLElement>('.setting-row .select');
  await press(triggers[1]);
  await vi.waitFor(() => {
    expect(document.querySelectorAll('[role="option"]').length).toBeGreaterThan(0);
  });
  const moderator = Array.from(document.querySelectorAll<HTMLElement>('[role="option"]')).find(
    (option) => option.textContent.includes('Moderator')
  );
  if (!moderator) throw new Error('moderator option missing');
  await press(moderator);

  await vi.waitFor(() => {
    expect(core.setUserPowerLevel).toHaveBeenCalledWith(
      '!room:example.org',
      '@bob:example.org',
      50
    );
  });
  await vi.waitFor(() => {
    expect(names()).toEqual(['Bob', 'Alice']);
  });

  await unmount(instance);
});
