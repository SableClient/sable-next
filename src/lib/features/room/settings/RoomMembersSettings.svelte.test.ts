// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { MemberView, RoomPermissionsView, RoomSummary } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

import { core as baseCore } from '#lib/core/__mocks__/context.js';

const core = Object.assign(baseCore, {
  roomMembers: vi.fn<() => Promise<MemberView[]>>(),
  kickUser: vi.fn<(roomId: string, userId: string, reason?: string | null) => Promise<void>>(),
  banUser: vi.fn<(roomId: string, userId: string, reason?: string | null) => Promise<void>>(),
  unbanUser: vi.fn<() => Promise<void>>(),
  setUserPowerLevel: vi.fn<() => Promise<void>>(),
  inviteUser: vi.fn<(roomId: string, userId: string) => Promise<void>>(),
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

test('invites from the members list when the account may invite', async () => {
  core.roomMembers.mockResolvedValue([alice]);
  core.inviteUser.mockResolvedValue(undefined);
  const instance = mount(RoomMembersSettings, {
    target: document.body,
    props: { room, permissions: { ...permissions, can_invite: true } },
  });
  await vi.waitFor(() => {
    expect(document.querySelector('.setting-row')).not.toBeNull();
  });

  const inviteButton = Array.from(
    document.querySelectorAll<HTMLButtonElement>('.search button')
  ).find((button) => button.textContent.trim() === 'Invite');
  if (!inviteButton) throw new Error('invite button missing');
  inviteButton.click();
  await tick();

  const input = await vi.waitFor(() => {
    const found = document.querySelector<HTMLInputElement>('#room-invite-user');
    if (!found) throw new Error('invite input missing');
    return found;
  });
  input.value = '@bob:example.org';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await vi.waitFor(() => {
    expect(core.inviteUser).toHaveBeenCalledWith('!room:example.org', '@bob:example.org');
  });

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
