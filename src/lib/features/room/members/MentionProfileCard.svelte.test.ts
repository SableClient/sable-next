// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { tick } from 'svelte';
import { describe, expect, test, vi } from 'vitest';

import type {
  MemberView,
  MutualRoomView,
  ProfileView,
  RoomPermissionsView,
} from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

import { core as baseCore } from '#lib/core/__mocks__/context.js';
import { CoreError } from '#src/transport';

const core = Object.assign(baseCore, {
  session: { user_id: '@me:example.org' },
  createDm: vi.fn<() => Promise<string>>(),
  userRelations: vi.fn<() => Promise<{ mutualRooms: MutualRoomView[]; ignored: boolean }>>(),
  setUserIgnored: vi.fn<() => Promise<void>>(),
  sendMessage: vi.fn<() => Promise<void>>(),
  kickUser: vi.fn<(roomId: string, userId: string, reason?: string | null) => Promise<void>>(),
  banUser: vi.fn<(roomId: string, userId: string, reason?: string | null) => Promise<void>>(),
  setUserPowerLevel: vi.fn<(roomId: string, userId: string, level: number) => Promise<void>>(),
  roomMembers: vi.fn<(roomId: string, memberships?: readonly string[]) => Promise<MemberView[]>>(
    () => Promise.resolve([])
  ),
});

vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));

import { goto } from '#lib/test-support/app-navigation.js';

const toastError = vi.hoisted(() => vi.fn());
vi.mock('#lib/ui/toasts.svelte.js', () => ({ toasts: { error: toastError } }));

vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  useRoomList: () => ({
    rooms: [],
    byId: (roomId: string) =>
      roomId === '!dm:example.org' ? { room_id: roomId, is_direct: true } : undefined,
  }),
  roomPathParamFromId: (roomId: string) => roomId,
}));

vi.mock('#lib/rooms/presence.svelte.js', async () => {
  const actual = await vi.importActual<typeof import('#lib/rooms/presence.svelte.js')>(
    '#lib/rooms/presence.svelte.js'
  );
  return { ...actual, usePresenceStore: () => ({ get: () => null, peek: () => null }) };
});

import { preferences } from '#lib/settings/preferences.svelte.js';

import MentionProfileCard from './MentionProfileCard.svelte';
import MemberIdentityRow from './MemberIdentityRow.svelte';

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
  supporter_awards: null,
  legacy_fields: [],
};

core.userRelations.mockResolvedValue({ mutualRooms: [], ignored: false });

const user = userEvent.setup();

test('hides sidebar pills without hiding profile pronouns', async () => {
  const profile = {
    ...emptyProfile,
    display_name: 'Alice',
    pronouns: [{ summary: 'they/them', language: null }],
  };
  core.userProfile.mockResolvedValueOnce(profile);
  render(MemberIdentityRow, { userId: profile.user_id, members: [] });
  render(MentionProfileCard, {
    userId: profile.user_id,
    roomId: '!room:example.org',
    member: null,
    profile,
  });
  await vi.waitFor(() => {
    expect(
      document.querySelector('.member-identity-row .sender-identity-pronoun')
    ).toHaveTextContent('they/them');
  });

  try {
    preferences.showPronounPills = false;
    await tick();
    expect(document.querySelector('.member-identity-row .sender-identity-pronoun')).toBeNull();
    expect(document.querySelector('.profile-pronoun-pill')).toHaveTextContent('they/them');
  } finally {
    preferences.showPronounPills = true;
  }
});

async function press(element: Element | null | undefined): Promise<void> {
  if (!element) throw new Error('nothing to press');
  await user.click(element);
}

async function chooseAction(name: string): Promise<void> {
  await user.click(screen.getByRole('button', { name: 'More actions' }));
  await user.click(await screen.findByRole('menuitem', { name: new RegExp(name) }));
}

test('keeps the clicked room member identity when the global profile loads', async () => {
  render(MentionProfileCard, {
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
});

test('uses the room role name, emoji and colour when the profile has no name colour', async () => {
  render(MentionProfileCard, {
    props: {
      userId: '@alice:example.org',
      roomId: '!room:example.org',
      member: {
        user_id: '@alice:example.org',
        display_name: 'Room Alice',
        avatar_url: null,
        power_level: 50,
        membership: 'join',
        member_ts: null,
        kicked: false,
        service: false,
      },
      profile: emptyProfile,
      powerTags: { 50: { name: 'Sentinel', color: '#ff0000', icon: '🛡️' } },
    },
  });
  await tick();

  expect(document.querySelector('.profile-card-meta')?.textContent).toContain('🛡️');
  expect(document.querySelector('.profile-card-meta')?.textContent).toContain('Sentinel');
  expect(document.querySelector('.profile-card')?.getAttribute('style')).toContain('#cf0000');
});

test('leaves out the bio and metadata panels when the profile has neither', async () => {
  render(MentionProfileCard, {
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
});

test('opens a profile avatar through viewer callback', async () => {
  const onAvatarClick = vi.fn();
  core.fetchMedia.mockResolvedValue(new Uint8Array(new ArrayBuffer()));
  render(MentionProfileCard, {
    props: {
      userId: '@alice:example.org',
      roomId: '!room:example.org',
      member: null,
      profile: { ...emptyProfile, display_name: 'Alice', avatar_url: 'mxc://example.org/avatar' },
      onAvatarClick,
    },
  });
  await tick();

  const avatarButton = screen.getByRole('button', { name: "View Alice's avatar" });
  expect(avatarButton.querySelector('.avatar-root')).toHaveAttribute('aria-hidden', 'true');
  await user.click(avatarButton);

  expect(onAvatarClick).toHaveBeenCalledWith('mxc://example.org/avatar', 'Alice');
});

test('loads a member card avatar from the original media', async () => {
  core.fetchMedia.mockResolvedValue(new Uint8Array([0x47, 0x49, 0x46, 0x38]));
  render(MentionProfileCard, {
    props: {
      userId: '@alice:example.org',
      roomId: '!room:example.org',
      member: null,
      profile: { ...emptyProfile, display_name: 'Alice', avatar_url: 'mxc://example.org/animated' },
    },
  });

  await vi.waitFor(() => {
    expect(core.fetchMedia).toHaveBeenCalledWith('mxc://example.org/animated', 0, 0);
  });
});

test('sends a direct message from the sheet composer', async () => {
  core.createDm.mockResolvedValue('!dm:example.org');
  core.sendMessage.mockResolvedValue(undefined);
  render(MentionProfileCard, {
    props: {
      userId: '@alice:example.org',
      roomId: '!room:example.org',
      member: null,
      profile: emptyProfile,
      variant: 'sheet',
    },
  });
  await tick();

  await user.type(screen.getByRole('textbox'), 'hi there{Enter}');
  await vi.waitFor(() => {
    expect(core.sendMessage).toHaveBeenCalledWith('!dm:example.org', 'hi there');
  });

  expect(core.createDm).toHaveBeenCalledWith('@alice:example.org');
  await vi.waitFor(() => {
    expect(goto).toHaveBeenCalledWith(expect.stringContaining('/direct/'));
  });
});

test('opens the chat without sending from the Message button', async () => {
  core.createDm.mockResolvedValue('!dm:example.org');
  render(MentionProfileCard, {
    props: {
      userId: '@alice:example.org',
      roomId: '!room:example.org',
      member: null,
      profile: emptyProfile,
    },
  });
  await tick();

  await user.click(screen.getByRole('button', { name: 'Message' }));
  await vi.waitFor(() => {
    expect(goto).toHaveBeenCalledWith(expect.stringContaining('/direct/'));
  });

  expect(core.createDm).toHaveBeenCalledWith('@alice:example.org');
  expect(core.sendMessage).not.toHaveBeenCalled();
});

function extraKeys(): string[] {
  return [...document.querySelectorAll('.profile-keys button')].map((key) =>
    key.textContent.trim()
  );
}

async function openExtra(key: string): Promise<void> {
  const button = [...document.querySelectorAll<HTMLButtonElement>('.profile-keys button')].find(
    (candidate) => candidate.textContent.trim() === key
  );
  await press(button);
}

test('renders the extended profile fields', async () => {
  render(MentionProfileCard, {
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
  expect(document.querySelector('.profile-pronoun-pill')?.textContent.trim()).toBe('she/her');
  expect(meta[0].textContent).toContain('(Europe/Paris)');
  expect(meta[1].textContent).toBe('Is cat, give headpats!');
  expect(document.querySelector('.profile-card-status')?.textContent.trim()).toBe(
    '🌙beyond the shore'
  );
  const toggle = document.querySelector<HTMLButtonElement>('button.profile-extra');
  expect(toggle?.textContent.trim()).toBe('Show misc. data (1 value)');
  expect(toggle?.getAttribute('aria-expanded')).toBe('false');
  await press(toggle);
  await tick();
  expect(toggle?.getAttribute('aria-expanded')).toBe('true');
  expect(extraKeys()).toEqual(['net.example.mood']);
});

test('renders a flat map field as a collapsed key/value table and anything else as JSON', async () => {
  render(MentionProfileCard, {
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

  const toggle = document.querySelector<HTMLButtonElement>('button.profile-extra');
  expect(toggle?.textContent.trim()).toBe('Show misc. data (2 values)');
  expect(document.querySelector('.profile-extra-open')).toBeNull();

  await press(toggle);
  await tick();
  expect(extraKeys()).toEqual(['net.example.links', 'net.example.nested']);

  await openExtra('net.example.links');
  expect(toggle?.textContent.trim()).toBe('net.example.links');
  const rows = [...document.querySelectorAll('.profile-extra-open tr')].map((row) => [
    row.querySelector('th')?.textContent,
    row.querySelector('td')?.textContent,
  ]);
  expect(rows).toEqual([
    ['site', '<b>x</b>'],
    ['age', '3'],
    ['cat', 'true'],
  ]);
  expect(document.querySelector('.profile-extra-open b')).toBeNull();

  await press(toggle);
  await tick();
  await press(toggle);
  await tick();
  await openExtra('net.example.nested');
  expect(document.querySelector('.profile-extra-open table')).toBeNull();
  expect(document.querySelector('.profile-extra-open')?.textContent.trim()).toBe('{"a":{"b":"c"}}');
});

test('does not invent an animal need', async () => {
  render(MentionProfileCard, {
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
});

test('reserves the metadata row while the profile is still loading', async () => {
  render(MentionProfileCard, {
    props: {
      userId: '@alice:example.org',
      roomId: '!room:example.org',
      member: null,
      profile: null,
    },
  });
  await tick();

  expect(document.querySelectorAll('.profile-card-meta .skeleton')).toHaveLength(2);
});

test('keeps a failed profile silent when the room member still names the user', async () => {
  render(MentionProfileCard, {
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
});

test('collects an optional reason before kicking a member', async () => {
  core.kickUser.mockResolvedValue(undefined);
  render(MentionProfileCard, {
    props: {
      userId: '@alice:example.org',
      roomId: '!room:example.org',
      ownPowerLevel: 100,
      permissions: {
        own_power_level: 100,
        can_post: true,
        can_react: true,
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

  await chooseAction('Remove from room');

  const dialog = await screen.findByRole('dialog');
  await user.type(
    within(dialog).getByRole('textbox', { name: 'Reason (optional, shown to the room)' }),
    'spamming links'
  );
  await user.click(within(dialog).getByRole('button', { name: 'Remove from room' }));
  await vi.waitFor(() => {
    expect(core.kickUser).toHaveBeenCalledWith(
      '!room:example.org',
      '@alice:example.org',
      'spamming links'
    );
  });
});

test('sends no reason when the moderation reason is left blank', async () => {
  core.banUser.mockResolvedValue(undefined);
  render(MentionProfileCard, {
    props: {
      userId: '@alice:example.org',
      roomId: '!room:example.org',
      ownPowerLevel: 100,
      permissions: {
        own_power_level: 100,
        can_post: true,
        can_react: true,
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

  await chooseAction('Ban from room');

  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: 'Ban from room' }));
  await vi.waitFor(() => {
    expect(core.banUser).toHaveBeenCalledWith('!room:example.org', '@alice:example.org', null);
  });
});

test('hides the kick action while the target membership is unknown', async () => {
  render(MentionProfileCard, {
    props: {
      userId: '@alice:example.org',
      roomId: '!room:example.org',
      ownPowerLevel: 100,
      permissions: {
        own_power_level: 100,
        can_post: true,
        can_react: true,
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
      member: null,
      profile: emptyProfile,
    },
  });
  await tick();

  await user.click(screen.getByRole('button', { name: 'More actions' }));

  expect(screen.queryByRole('menuitem', { name: /Remove from room/ })).toBeNull();
});

test('offers to remove a user whose pending invite is loaded from the room', async () => {
  core.roomMembers.mockResolvedValueOnce([
    {
      user_id: '@alice:example.org',
      display_name: 'Alice',
      avatar_url: null,
      power_level: 0,
      membership: 'invite',
      member_ts: null,
      kicked: false,
      service: false,
    },
  ]);
  render(MentionProfileCard, {
    props: {
      userId: '@alice:example.org',
      roomId: '!room:example.org',
      ownPowerLevel: 100,
      permissions: {
        own_power_level: 100,
        can_post: true,
        can_react: true,
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
      member: null,
      profile: emptyProfile,
    },
  });

  await user.click(screen.getByRole('button', { name: 'More actions' }));

  expect(await screen.findByRole('menuitem', { name: /Remove from room/ })).toBeInTheDocument();
  expect(core.roomMembers).toHaveBeenCalledWith('!room:example.org', ['invite']);
});

test('does not load room membership outside a room profile', async () => {
  core.roomMembers.mockClear();
  render(MentionProfileCard, {
    props: {
      userId: '@alice:example.org',
      roomId: '',
      member: null,
      profile: emptyProfile,
    },
  });
  await tick();

  expect(core.roomMembers).not.toHaveBeenCalled();
});

test('shows a permission message when the kick is refused', async () => {
  core.kickUser.mockRejectedValue(new CoreError({ code: 'denied' }));
  render(MentionProfileCard, {
    props: {
      userId: '@alice:example.org',
      roomId: '!room:example.org',
      ownPowerLevel: 100,
      permissions: {
        own_power_level: 100,
        can_post: true,
        can_react: true,
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

  await chooseAction('Remove from room');

  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: 'Remove from room' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent(
    "You don't have permission to do that in this room."
  );
});

test('shows a generic message when the kick fails for another reason', async () => {
  core.kickUser.mockRejectedValue(new CoreError({ code: 'failed', log_id: 'e1' }));
  render(MentionProfileCard, {
    props: {
      userId: '@alice:example.org',
      roomId: '!room:example.org',
      ownPowerLevel: 100,
      permissions: {
        own_power_level: 100,
        can_post: true,
        can_react: true,
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

  await chooseAction('Remove from room');

  const dialog = await screen.findByRole('dialog');
  await user.click(within(dialog).getByRole('button', { name: 'Remove from room' }));
  expect(await within(dialog).findByRole('alert')).toHaveTextContent(
    'That action could not be completed.'
  );
});

async function openRoleMenu(
  onPowerLevelChange: () => void,
  powerTags: Record<number, { name: string; color: null; icon: null }> = {}
) {
  const instance = render(MentionProfileCard, {
    props: {
      powerTags,
      userId: '@alice:example.org',
      roomId: '!room:example.org',
      ownPowerLevel: 100,
      permissions: {
        own_power_level: 100,
        can_post: true,
        can_react: true,
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

  await chooseAction('Change role');
  return instance;
}

async function changeRoleToModerator(onPowerLevelChange: () => void): Promise<void> {
  const instance = await openRoleMenu(onPowerLevelChange);
  await user.click(await screen.findByRole('menuitem', { name: /Moderator/ }));
  await vi.waitFor(() => {
    expect(core.setUserPowerLevel).toHaveBeenCalledWith(
      '!room:example.org',
      '@alice:example.org',
      50
    );
  });
  await Promise.resolve();
  instance.unmount();
}

test('reports a successful role change so the member list can follow it', async () => {
  core.setUserPowerLevel.mockReset().mockResolvedValue(undefined);
  toastError.mockClear();
  const onPowerLevelChange = vi.fn();

  await changeRoleToModerator(onPowerLevelChange);

  expect(onPowerLevelChange).toHaveBeenCalledWith('!room:example.org', '@alice:example.org', 50);
  expect(toastError).not.toHaveBeenCalled();
});

test('offers the custom roles of the room when changing a role', async () => {
  const instance = await openRoleMenu(vi.fn(), {
    75: { name: 'Steward', color: null, icon: null },
  });

  expect(await screen.findByRole('menuitem', { name: /Steward/ })).toBeInTheDocument();
  instance.unmount();
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

test('asks before lowering your own role', async () => {
  core.setUserPowerLevel.mockReset().mockResolvedValue(undefined);
  render(MentionProfileCard, {
    props: {
      userId: '@me:example.org',
      roomId: '!room:example.org',
      ownPowerLevel: 100,
      permissions: {
        own_power_level: 100,
        can_change_power_levels: true,
      } as RoomPermissionsView,
      member: {
        user_id: '@me:example.org',
        display_name: 'Me',
        avatar_url: null,
        power_level: 100,
        membership: 'join',
        member_ts: null,
        kicked: false,
        service: false,
      },
      profile: emptyProfile,
    },
  });
  await tick();

  await chooseAction('Change role');
  await user.click(await screen.findByRole('menuitem', { name: /Moderator/ }));
  const dialog = await screen.findByRole('dialog', { name: 'Give up your own role?' });
  expect(core.setUserPowerLevel).not.toHaveBeenCalled();

  await user.click(within(dialog).getByRole('button', { name: 'Lower my role' }));
  await vi.waitFor(() => {
    expect(core.setUserPowerLevel).toHaveBeenCalledWith('!room:example.org', '@me:example.org', 50);
  });
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
  render(MentionProfileCard, {
    props: {
      userId: '@alice:example.org',
      roomId: '!room:example.org',
      member: null,
      profile: emptyProfile,
    },
  });
  await user.click(await screen.findByRole('button', { name: /3 mutual rooms/ }));
  await tick();
  await tick();

  const names = [...document.querySelectorAll('.profile-mutual-name')].map(
    (node) => node.textContent
  );
  expect(names).toEqual(['Space', 'General', 'Alice']);
  expect(document.querySelector('.profile-card-bio')).toBeNull();
});

test('shows a misc field in full as JSON with developer tools on, and a preview without', async () => {
  const value = JSON.stringify({ site: 'x'.repeat(300) });
  const open = async () => {
    const instance = render(MentionProfileCard, {
      props: {
        userId: '@alice:example.org',
        roomId: '!room:example.org',
        member: null,
        profile: { ...emptyProfile, extra: [{ key: 'net.example.links', value }] },
      },
    });
    await tick();
    await press(document.querySelector('button.profile-extra'));
    await tick();
    await press(document.querySelector('.profile-keys button'));
    await tick();
    return instance;
  };

  preferences.developerTools = true;
  const instance = await open();
  expect(document.querySelector('.profile-extra-json')?.textContent).toBe(
    JSON.stringify(JSON.parse(value), null, 2)
  );
  instance.unmount();

  preferences.developerTools = false;
  await open();
  expect(document.querySelector('.profile-extra-json')).toBeNull();
  expect(document.querySelector('.profile-extra-open')?.textContent.trim()).toBe(
    value.slice(0, 256)
  );
});

describe('invite and unban follow the membership', () => {
  const permissions = {
    own_power_level: 100,
    can_post: true,
    can_react: true,
    can_redact_own: true,
    can_redact_others: false,
    can_invite: true,
    can_kick: true,
    can_ban: true,
    can_change_settings: false,
    can_pin: false,
    can_change_join_rule: false,
    can_change_power_levels: false,
    can_manage_children: false,
  };
  const memberWith = (membership: 'join' | 'leave' | 'ban') => ({
    user_id: '@alice:example.org',
    display_name: 'Alice',
    avatar_url: null,
    power_level: 0,
    membership,
    member_ts: null,
    kicked: false,
    service: false,
  });
  const openMenu = async (member: ReturnType<typeof memberWith> | null) => {
    render(MentionProfileCard, {
      props: {
        userId: '@alice:example.org',
        roomId: '!room:example.org',
        ownPowerLevel: 100,
        permissions,
        member,
        profile: emptyProfile,
      },
    });
    await tick();
    await user.click(screen.getByRole('button', { name: 'More actions' }));
  };

  test('offers Unban, and not Invite or Ban, for a banned member', async () => {
    await openMenu(memberWith('ban'));

    expect(await screen.findByRole('menuitem', { name: /Unban/ })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: /Invite/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Ban from room/ })).toBeNull();
  });

  test('offers Invite, and not Unban, for someone who left', async () => {
    await openMenu(memberWith('leave'));

    expect(await screen.findByRole('menuitem', { name: /Invite/ })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: /Unban/ })).toBeNull();
  });

  test('offers neither for a member who is in the room', async () => {
    await openMenu(memberWith('join'));

    expect(await screen.findByRole('menuitem', { name: /Remove from room/ })).toBeTruthy();
    expect(screen.queryByRole('menuitem', { name: /Invite/ })).toBeNull();
    expect(screen.queryByRole('menuitem', { name: /Unban/ })).toBeNull();
  });
});
