// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { MutualRoomView, ProfileView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

import { core as baseCore } from '#lib/core/__mocks__/context.js';

const core = Object.assign(baseCore, {
  session: { user_id: '@me:example.org' },
  createDm: vi.fn<() => Promise<string>>(),
  userRelations: vi.fn<() => Promise<{ mutualRooms: MutualRoomView[]; ignored: boolean }>>(),
  setUserIgnored: vi.fn<() => Promise<void>>(),
  sendMessage: vi.fn<() => Promise<void>>(),
  kickUser: vi.fn<(roomId: string, userId: string, reason?: string | null) => Promise<void>>(),
  banUser: vi.fn<(roomId: string, userId: string, reason?: string | null) => Promise<void>>(),
  setUserPowerLevel: vi.fn<(roomId: string, userId: string, level: number) => Promise<void>>(),
});

const toastError = vi.hoisted(() => vi.fn());
vi.mock('#lib/ui/toasts.svelte.js', () => ({ toasts: { error: toastError } }));

vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  useRoomList: () => ({
    rooms: [],
    byId: (roomId: string) =>
      roomId === '!dm:example.org' ? { room_id: roomId, is_direct: true } : undefined,
  }),
}));

vi.mock('#lib/rooms/presence.svelte.js', async () => {
  const actual = await vi.importActual<typeof import('#lib/rooms/presence.svelte.js')>(
    '#lib/rooms/presence.svelte.js'
  );
  return { ...actual, usePresenceStore: () => ({ get: () => null }) };
});

import MentionProfileCard from './MentionProfileCard.svelte';

const emptyProfile: ProfileView = {
  user_id: '@alice:example.org',
  display_name: null,
  avatar_url: null,
  bio: null,
  hero_color: null,
  hero_brightness: null,
  banner_url: null,
  status: null,
  pronouns: [],
  timezone: null,
  name_color_light: null,
  name_color_dark: null,
  animal: null,
  extra: [],
};

core.userRelations.mockResolvedValue({ mutualRooms: [], ignored: false });

afterEach(() => {
  document.body.replaceChildren();
});

test('keeps the clicked room member identity when the global profile loads', async () => {
  const instance = mount(MentionProfileCard, {
    target: document.body,
    props: {
      userId: '@alice:example.org',
      roomId: '!room:example.org',
      member: {
        user_id: '@alice:example.org',
        display_name: 'Room Alice',
        avatar_url: null,
        power_level: 0,
        membership: 'join',
        member_ts: null,
        kicked: false,
        service: false,
      },
      profile: {
        ...emptyProfile,
        display_name: 'Global Alice',
        bio: '<strong>Global bio</strong>',
      },
    },
  });
  await tick();

  expect(document.querySelector('.profile-card-name')?.textContent).toBe('Room Alice');
  expect(document.querySelector('.profile-card-bio strong')?.textContent).toBe('Global bio');
  await unmount(instance);
});

test('leaves out the bio and metadata panels when the profile has neither', async () => {
  const instance = mount(MentionProfileCard, {
    target: document.body,
    props: {
      userId: '@alice:example.org',
      roomId: '!room:example.org',
      member: null,
      profile: emptyProfile,
    },
  });
  await tick();

  expect(document.querySelector('.profile-card-bio')).toBeNull();
  expect(document.querySelector('.profile-card-meta')).toBeNull();
  expect(document.querySelector('.profile-card-footer')).toBeNull();
  await unmount(instance);
});

test('opens a profile avatar through viewer callback', async () => {
  const onAvatarClick = vi.fn();
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  const instance = mount(MentionProfileCard, {
    target: document.body,
    props: {
      userId: '@alice:example.org',
      roomId: '!room:example.org',
      member: null,
      profile: { ...emptyProfile, display_name: 'Alice', avatar_url: 'mxc://example.org/avatar' },
      onAvatarClick,
    },
  });
  await tick();

  const avatarButton = document.querySelector<HTMLButtonElement>('.profile-card-avatar-button');
  if (!avatarButton) throw new Error('profile avatar button missing');
  expect(avatarButton.getAttribute('aria-label')).toBe("View Alice's avatar");
  expect(avatarButton.querySelector('.avatar-root')?.getAttribute('aria-hidden')).toBe('true');
  avatarButton.click();

  expect(onAvatarClick).toHaveBeenCalledWith('mxc://example.org/avatar', 'Alice');
  await unmount(instance);
});

test('sends a direct message from the composer', async () => {
  core.createDm.mockResolvedValue('!dm:example.org');
  core.sendMessage.mockResolvedValue(undefined);
  const instance = mount(MentionProfileCard, {
    target: document.body,
    props: {
      userId: '@alice:example.org',
      roomId: '!room:example.org',
      member: null,
      profile: emptyProfile,
    },
  });
  await tick();

  const input = document.querySelector<HTMLInputElement>('.profile-composer-input');
  if (!input) throw new Error('composer input missing');
  input.value = 'hi there';
  input.dispatchEvent(new Event('input', { bubbles: true }));
  await tick();
  document.querySelector('.profile-composer')?.dispatchEvent(new Event('submit'));
  await vi.waitFor(() => {
    expect(core.sendMessage).toHaveBeenCalledWith('!dm:example.org', 'hi there');
  });

  expect(core.createDm).toHaveBeenCalledWith('@alice:example.org');
  await unmount(instance);
});

test('renders the extended profile fields', async () => {
  const instance = mount(MentionProfileCard, {
    target: document.body,
    props: {
      userId: '@alice:example.org',
      roomId: '!room:example.org',
      member: null,
      profile: {
        ...emptyProfile,
        status: { text: 'beyond the shore', emoji: '🌙' },
        pronouns: [
          { summary: 'she/her', language: 'en' },
          { summary: 'iel', language: 'fr' },
        ],
        timezone: 'Europe/Paris',
        animal: { is_animal: 'cat', has_animal: null, animal_need: 'headpats' },
        extra: [{ key: 'net.example.mood', value: 'sleepy' }],
      },
    },
  });
  await tick();

  const meta = document.querySelectorAll('.profile-card-meta .profile-meta-item');
  expect(meta[0].textContent).toBe('she/her');
  expect(meta[1].textContent).toContain('(Europe/Paris)');
  expect(meta[2].textContent).toBe('Is cat, give headpats!');
  expect(document.querySelector('.profile-card-status')?.textContent.trim()).toBe(
    '🌙beyond the shore'
  );
  expect(document.querySelector('.profile-extra summary')?.textContent.trim()).toBe(
    'Show misc. data (1 value)'
  );
  expect(document.querySelector('.profile-extra dt')?.textContent).toBe('net.example.mood');
  await unmount(instance);
});

test('renders a flat map field as a collapsed key/value table and anything else as JSON', async () => {
  const instance = mount(MentionProfileCard, {
    target: document.body,
    props: {
      userId: '@alice:example.org',
      roomId: '!room:example.org',
      member: null,
      profile: {
        ...emptyProfile,
        extra: [
          { key: 'net.example.links', value: '{"site":"<b>x</b>","age":3,"cat":true}' },
          { key: 'net.example.nested', value: '{"a":{"b":"c"}}' },
        ],
      },
    },
  });
  await tick();

  const toggle = document.querySelector<HTMLButtonElement>('.profile-extra-toggle');
  expect(toggle?.textContent.trim()).toBe('net.example.links');
  expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  const panel = document.getElementById(toggle?.getAttribute('aria-controls') ?? '');
  expect(panel?.hidden).toBe(true);

  const rows = [...(panel?.querySelectorAll('tr') ?? [])].map((row) => [
    row.querySelector('th')?.textContent,
    row.querySelector('td')?.textContent,
  ]);
  expect(rows).toEqual([
    ['site', '<b>x</b>'],
    ['age', '3'],
    ['cat', 'true'],
  ]);
  expect(panel?.querySelector('b')).toBeNull();

  toggle?.click();
  await tick();
  expect(toggle?.getAttribute('aria-expanded')).toBe('true');
  expect(panel?.hidden).toBe(false);

  expect(document.querySelectorAll('.profile-extra table')).toHaveLength(1);
  const nested = [...document.querySelectorAll('.profile-extra dt')].find(
    (term) => term.textContent === 'net.example.nested'
  );
  expect(nested?.nextElementSibling?.textContent).toBe('{"a":{"b":"c"}}');
  await unmount(instance);
});

test('does not invent an animal need', async () => {
  const instance = mount(MentionProfileCard, {
    target: document.body,
    props: {
      userId: '@alice:example.org',
      roomId: '!room:example.org',
      member: null,
      profile: {
        ...emptyProfile,
        animal: { is_animal: 'cat', has_animal: null, animal_need: null },
      },
    },
  });
  await tick();

  expect(document.querySelector('.profile-card-meta .profile-meta-item')?.textContent).toBe(
    'Is cat!'
  );
  await unmount(instance);
});

test('reserves the metadata row while the profile is still loading', async () => {
  const instance = mount(MentionProfileCard, {
    target: document.body,
    props: {
      userId: '@alice:example.org',
      roomId: '!room:example.org',
      member: null,
      profile: null,
    },
  });
  await tick();

  expect(document.querySelectorAll('.profile-card-meta .skeleton')).toHaveLength(2);
  await unmount(instance);
});

test('keeps a failed profile silent when the room member still names the user', async () => {
  const instance = mount(MentionProfileCard, {
    target: document.body,
    props: {
      userId: '@alice:example.org',
      roomId: '!room:example.org',
      member: {
        user_id: '@alice:example.org',
        display_name: 'Room Alice',
        avatar_url: null,
        power_level: 0,
        membership: 'join',
        member_ts: null,
        kicked: false,
        service: false,
      },
      profile: null,
      failed: true,
    },
  });
  await tick();

  expect(document.querySelector('[role="status"]')).toBeNull();
  expect(document.querySelector('.profile-card-name')?.textContent).toBe('Room Alice');
  await unmount(instance);
});

test('collects an optional reason before kicking a member', async () => {
  core.kickUser.mockResolvedValue(undefined);
  const instance = mount(MentionProfileCard, {
    target: document.body,
    props: {
      userId: '@alice:example.org',
      roomId: '!room:example.org',
      ownPowerLevel: 100,
      permissions: {
        own_power_level: 100,
        can_post: true,
        can_redact_own: true,
        can_redact_others: false,
        can_invite: false,
        can_kick: true,
        can_ban: false,
        can_change_settings: false,
        can_pin: false,
        can_change_join_rule: false,
        can_change_power_levels: false,
        can_manage_children: false,
      },
      member: {
        user_id: '@alice:example.org',
        display_name: 'Alice',
        avatar_url: null,
        power_level: 0,
        membership: 'join',
        member_ts: null,
        kicked: false,
        service: false,
      },
      profile: emptyProfile,
    },
  });
  await tick();

  document
    .querySelector<HTMLButtonElement>('[aria-label="More actions"]')
    ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  await tick();
  document.querySelectorAll<HTMLElement>('[role="menuitem"]').forEach((item) => {
    if (item.textContent.includes('Remove from room')) item.click();
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
  core.banUser.mockResolvedValue(undefined);
  const instance = mount(MentionProfileCard, {
    target: document.body,
    props: {
      userId: '@alice:example.org',
      roomId: '!room:example.org',
      ownPowerLevel: 100,
      permissions: {
        own_power_level: 100,
        can_post: true,
        can_redact_own: true,
        can_redact_others: false,
        can_invite: false,
        can_kick: false,
        can_ban: true,
        can_change_settings: false,
        can_pin: false,
        can_change_join_rule: false,
        can_change_power_levels: false,
        can_manage_children: false,
      },
      member: {
        user_id: '@alice:example.org',
        display_name: 'Alice',
        avatar_url: null,
        power_level: 0,
        membership: 'join',
        member_ts: null,
        kicked: false,
        service: false,
      },
      profile: emptyProfile,
    },
  });
  await tick();

  document
    .querySelector<HTMLButtonElement>('[aria-label="More actions"]')
    ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  await tick();
  document.querySelectorAll<HTMLElement>('[role="menuitem"]').forEach((item) => {
    if (item.textContent.includes('Ban from room')) item.click();
  });
  await tick();

  document.querySelector<HTMLButtonElement>('.moderation-actions .btn-danger')?.click();
  await vi.waitFor(() => {
    expect(core.banUser).toHaveBeenCalledWith('!room:example.org', '@alice:example.org', null);
  });

  await unmount(instance);
});

async function changeRoleToModerator(onPowerLevelChange: () => void): Promise<void> {
  const instance = mount(MentionProfileCard, {
    target: document.body,
    props: {
      userId: '@alice:example.org',
      roomId: '!room:example.org',
      ownPowerLevel: 100,
      permissions: {
        own_power_level: 100,
        can_post: true,
        can_redact_own: true,
        can_redact_others: false,
        can_invite: false,
        can_kick: false,
        can_ban: false,
        can_change_settings: false,
        can_pin: false,
        can_change_join_rule: false,
        can_change_power_levels: true,
        can_manage_children: false,
      },
      member: {
        user_id: '@alice:example.org',
        display_name: 'Alice',
        avatar_url: null,
        power_level: 0,
        membership: 'join',
        member_ts: null,
        kicked: false,
        service: false,
      },
      profile: emptyProfile,
      onPowerLevelChange,
    },
  });
  await tick();

  document
    .querySelector<HTMLButtonElement>('[aria-label="More actions"]')
    ?.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
  await tick();
  document.querySelectorAll<HTMLElement>('[role="menuitem"]').forEach((item) => {
    if (item.textContent.includes('Change role')) item.click();
  });
  await vi.waitFor(() => {
    const moderator = Array.from(document.querySelectorAll<HTMLElement>('[role="menuitem"]')).find(
      (item) => item.textContent.includes('Moderator')
    );
    if (!moderator) throw new Error('moderator item missing');
    moderator.click();
  });
  await vi.waitFor(() => {
    expect(core.setUserPowerLevel).toHaveBeenCalledWith(
      '!room:example.org',
      '@alice:example.org',
      50
    );
  });
  await Promise.resolve();
  await unmount(instance);
}

test('reports a successful role change so the member list can follow it', async () => {
  core.setUserPowerLevel.mockReset().mockResolvedValue(undefined);
  toastError.mockClear();
  const onPowerLevelChange = vi.fn();

  await changeRoleToModerator(onPowerLevelChange);

  expect(onPowerLevelChange).toHaveBeenCalledWith('!room:example.org', '@alice:example.org', 50);
  expect(toastError).not.toHaveBeenCalled();
});

test('toasts a failed role change and reports nothing', async () => {
  core.setUserPowerLevel.mockReset().mockRejectedValue(new Error('forbidden'));
  toastError.mockClear();
  const onPowerLevelChange = vi.fn();
  vi.spyOn(console, 'warn').mockImplementation(() => {});

  await changeRoleToModerator(onPowerLevelChange);

  await vi.waitFor(() => {
    expect(toastError).toHaveBeenCalled();
  });
  expect(onPowerLevelChange).not.toHaveBeenCalled();
});

test('lists mutual rooms in a menu of their own, with direct messages last', async () => {
  core.userRelations.mockResolvedValueOnce({
    mutualRooms: [
      { room_id: '!dm:example.org', name: 'Alice', is_space: false },
      { room_id: '!general:example.org', name: 'General', is_space: false },
      { room_id: '!space:example.org', name: 'Space', is_space: true },
    ],
    ignored: false,
  });
  const instance = mount(MentionProfileCard, {
    target: document.body,
    props: {
      userId: '@alice:example.org',
      roomId: '!room:example.org',
      member: null,
      profile: emptyProfile,
    },
  });
  const rooms = await vi.waitFor(() => {
    const chip = [...document.querySelectorAll<HTMLButtonElement>('.profile-action')].find(
      (button) => button.textContent.includes('2 mutual rooms')
    );
    if (!chip) throw new Error('mutual rooms chip not rendered');
    return chip;
  });
  rooms.dispatchEvent(
    new PointerEvent('pointerdown', {
      bubbles: true,
      cancelable: true,
      pointerType: 'mouse',
      button: 0,
      isPrimary: true,
    })
  );
  await tick();
  await tick();

  const names = [...document.querySelectorAll('.profile-mutual-name')].map(
    (node) => node.textContent
  );
  expect(names).toEqual(['General', 'Alice']);
  expect(document.querySelector('.profile-card-bio')).toBeNull();
  await unmount(instance);
});
