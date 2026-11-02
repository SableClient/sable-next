// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { ProfileView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  useRoomList: () => ({ rooms: [] }),
}));

vi.mock('#lib/personas/personas.svelte.js', () => ({
  usePersonaStore: () => ({ personas: [], load: () => Promise.resolve() }),
}));

vi.mock('#lib/rooms/presence.svelte.js', async () => {
  const actual = await vi.importActual<typeof import('#lib/rooms/presence.svelte.js')>(
    '#lib/rooms/presence.svelte.js'
  );
  return { ...actual, usePresenceStore: () => ({ get: () => null, peek: () => null }) };
});

import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';
import { RoomMemberLoader } from '#lib/rooms/room-members.svelte.js';
import { RoomCosmetics } from '#lib/rooms/room-cosmetics.svelte.js';

import TimelineItemHarness from './TimelineItemHarness.test.svelte';
import { core, press, resetTimelineItemTest, item, replyItem } from './timeline-item-fixtures';
import { FOUNDER_POWER_LEVEL, powerTag } from '../members/power-tags';
import { tagForLevel } from '../settings/power-level-tags';

afterEach(resetTimelineItemTest);

test('shows the sender’s role icon after their name', async () => {
  render(TimelineItemHarness, {
    props: {
      core,
      item: { item: item(false), collapsed: false },
      roles: { '@alice:example.org': { icon: '🛡️', name: 'Moderator', color: null } },
    },
  });
  await tick();

  const icon = document.querySelector('header .role-tag-icon');
  expect(icon?.textContent).toBe('🛡️');
  expect(icon?.previousElementSibling?.classList.contains('sender-identity')).toBe(true);
});

test('shows the role name on hover only when the setting is on', async () => {
  setPreference('showRoleTooltip', true);
  render(TimelineItemHarness, {
    props: {
      core,
      item: { item: item(false), collapsed: false },
      roles: { '@alice:example.org': { icon: '🛡️', name: 'Moderator', color: null } },
    },
  });
  await tick();

  const role = document.querySelector('header .sender-role');
  if (role) await userEvent.hover(role);
  expect(await screen.findByText('Moderator', {}, { timeout: 2000 })).toBeTruthy();
});

test('displays saved founder flair on a message', async () => {
  core.userProfile.mockResolvedValue({ name_color_light: null, name_color_dark: null });
  const tags = {
    [FOUNDER_POWER_LEVEL]: { name: 'Founder', color: '#c04040', icon: '👑' },
  };
  render(TimelineItemHarness, {
    props: {
      core,
      item: { item: item(false), collapsed: false },
      roles: {
        '@alice:example.org': {
          icon: tagForLevel(tags, FOUNDER_POWER_LEVEL)?.icon ?? null,
          name: 'Founder',
          color: powerTag(FOUNDER_POWER_LEVEL, (key) => key, tags).color,
        },
      },
    },
  });
  await tick();

  expect(document.querySelector('header .role-tag-icon')?.textContent).toBe('👑');
  const message = document.querySelector<HTMLElement>('.message');
  expect(message?.style.getPropertyValue('--name-color-on-light')).toBe('#b8383a');
  expect(message?.style.getPropertyValue('--name-color-on-dark')).toBe('#ee6a65');
});

test('clicking the sender name mentions the account behind it', async () => {
  const onMentionUser = vi.fn();
  render(TimelineItemHarness, {
    props: {
      core,
      item: {
        item: {
          ...item(false),
          per_message_profile: {
            id: 'kris',
            display_name: 'Kris',
            avatar_url: null,
            pronouns: [],
            color_on_light: null,
            color_on_dark: null,
            has_fallback: false,
            biography: null,
            banner_url: null,
            is_animal: null,
            has_animal: null,
            animal_need: null,
          },
        },
        collapsed: false,
        onMentionUser,
      },
    },
  });
  await tick();

  await press(document.querySelector<HTMLButtonElement>('header button.sender'));

  expect(onMentionUser).toHaveBeenCalledWith('@alice:example.org', 'Alice');
});

test('with profile on name click, the sender name opens the profile instead', async () => {
  preferences.usernameClick = 'profile';
  const onMentionUser = vi.fn();
  const onSenderProfile = vi.fn();
  render(TimelineItemHarness, {
    props: {
      core,
      item: { item: item(false), collapsed: false, onMentionUser, onSenderProfile },
    },
  });
  await tick();

  await press(document.querySelector<HTMLButtonElement>('header button.sender'));

  expect(onSenderProfile).toHaveBeenCalledWith('@alice:example.org', expect.any(HTMLElement), null);
  expect(onMentionUser).not.toHaveBeenCalled();
  preferences.usernameClick = 'mention';
});

test('a per-message profile takes the sender position and names the account behind it', async () => {
  core.userProfile.mockResolvedValue({
    name_color_light: '#2244aa',
    name_color_dark: '#88aaff',
  });
  const onSenderProfile = vi.fn();
  const persona = {
    ...item(false),
    per_message_profile: {
      id: 'kris',
      display_name: 'Kris',
      avatar_url: null,
      pronouns: [{ summary: 'they/them', language: null }],
      color_on_light: '#4f7a3a',
      color_on_dark: '#9fd07c',
      has_fallback: false,
      biography: null,
      banner_url: null,
      is_animal: null,
      has_animal: null,
      animal_need: null,
    },
  };
  render(TimelineItemHarness, {
    props: {
      core,
      item: { item: persona, collapsed: false, onSenderProfile },
    },
  });
  await tick();

  expect(document.querySelector('header .sender')?.textContent.trim()).toBe('Kris');
  expect(document.querySelector('header .sender-identity-pronoun')?.textContent).toBe('they/them');

  const via = document.querySelector('header .sender-identity-via');
  expect(via?.textContent).toContain('Alice');
  expect(via?.textContent).not.toContain('@alice:example.org');

  const viaButton = via?.querySelector<HTMLButtonElement>('.name-button');
  if (!viaButton) throw new Error('the account behind the persona was not a button');
  await press(viaButton);
  expect(onSenderProfile).toHaveBeenCalledWith('@alice:example.org', viaButton);
});

test('without a persona the hover-only via keeps the account MXID', async () => {
  render(TimelineItemHarness, {
    props: { core, item: { item: item(false), collapsed: false } },
  });
  await tick();

  const via = document.querySelector('header .via');
  expect(via?.className).toContain('via-hidden');
  expect(via?.textContent).toContain('@alice:example.org');
});

test('shows every pronoun set from the sender account profile', async () => {
  core.userProfile.mockResolvedValue({
    pronouns: [
      { summary: 'she/her', language: null },
      { summary: 'they/them', language: null },
    ],
  });
  render(TimelineItemHarness, {
    props: { core, item: { item: item(false), collapsed: false } },
  });
  await vi.waitFor(() => {
    expect(document.querySelectorAll('header .sender-identity-pronoun')).toHaveLength(2);
  });
});

test('lifts trailing pronouns out of the display name into a pill', async () => {
  core.userProfile.mockResolvedValue({ pronouns: [] });
  render(TimelineItemHarness, {
    props: {
      core,
      item: { item: { ...item(false), sender_name: 'sugary (she/it)' }, collapsed: false },
    },
  });
  await vi.waitFor(() => {
    const name = document.querySelector('header .sender-identity-name');
    expect(name?.textContent).toBe('sugary');
    const pills = document.querySelectorAll('header .sender-identity-pronoun');
    expect(pills).toHaveLength(1);
    expect(pills[0].textContent).toBe('she/it');
  });
});

test('adds the display name pronouns after the structured sets', async () => {
  core.userProfile.mockResolvedValue({
    pronouns: [{ summary: 'they/them', language: null }],
  });
  render(TimelineItemHarness, {
    props: {
      core,
      item: { item: { ...item(false), sender_name: 'sugary (she/it)' }, collapsed: false },
    },
  });
  await vi.waitFor(() => {
    const name = document.querySelector('header .sender-identity-name');
    expect(name?.textContent).toBe('sugary');
    const pills = document.querySelectorAll('header .sender-identity-pronoun');
    expect([...pills].map((pill) => pill.textContent)).toEqual(['they/them', 'she/it']);
  });
});

test.each(['showPronouns', 'showPronounPills'] as const)(
  'keeps the display name suffix when %s is disabled',
  async (preference) => {
    setPreference(preference, false);
    core.userProfile.mockResolvedValue({
      pronouns: [{ summary: 'they/them', language: null }],
    });
    render(TimelineItemHarness, {
      props: {
        core,
        item: { item: { ...item(false), sender_name: 'sugary (she/it)' }, collapsed: false },
      },
    });
    await tick();
    expect(document.querySelector('header .sender-identity-name')?.textContent).toBe(
      'sugary (she/it)'
    );
    expect(document.querySelectorAll('header .sender-identity-pronoun')).toHaveLength(0);
    setPreference(preference, true);
    await vi.waitFor(() => {
      expect(document.querySelector('header .sender-identity-name')?.textContent).toBe('sugary');
      expect(document.querySelectorAll('header .sender-identity-pronoun')).toHaveLength(2);
    });
  }
);

test('shows only the sets tagged with the reader language', async () => {
  core.userProfile.mockResolvedValue({
    pronouns: [
      { summary: 'she/her', language: 'en' },
      { summary: 'elle', language: 'fr' },
    ],
  });
  render(TimelineItemHarness, {
    props: { core, item: { item: item(false), collapsed: false } },
  });
  await vi.waitFor(() => {
    const pills = document.querySelectorAll('header .sender-identity-pronoun');
    expect(pills).toHaveLength(1);
    expect(pills[0].textContent).toBe('she/her');
  });
});

test('shows every set once the language filter is switched off', async () => {
  setPreference('filterPronounsByLanguage', false);
  core.userProfile.mockResolvedValue({
    pronouns: [
      { summary: 'she/her', language: 'en' },
      { summary: 'elle', language: 'fr' },
    ],
  });
  render(TimelineItemHarness, {
    props: { core, item: { item: item(false), collapsed: false } },
  });
  await vi.waitFor(() => {
    expect(document.querySelectorAll('header .sender-identity-pronoun')).toHaveLength(2);
  });
  setPreference('filterPronounsByLanguage', true);
  await vi.waitFor(() => {
    expect(document.querySelectorAll('header .sender-identity-pronoun')).toHaveLength(1);
  });
});

test('caps the pills at three and counts the rest', async () => {
  core.userProfile.mockResolvedValue({
    pronouns: [
      { summary: 'she/her', language: 'en' },
      { summary: 'they/them', language: 'en' },
      { summary: 'he/him', language: 'en' },
      { summary: 'it/its', language: 'en' },
    ],
  });
  render(TimelineItemHarness, {
    props: { core, item: { item: item(false), collapsed: false } },
  });
  await vi.waitFor(() => {
    const pills = document.querySelectorAll('header .sender-identity-pronoun');
    expect(pills).toHaveLength(4);
    expect(pills[3].textContent).toBe('+1');
  });
  await userEvent.hover(document.querySelectorAll('header .sender-identity-pronoun')[3]);
  expect(await screen.findByText('it/its (en)')).toBeInTheDocument();
});

test('shows the live member name over the one captured on the item', async () => {
  render(TimelineItemHarness, {
    props: {
      core,
      item: {
        item: { ...item(false), sender_name: 'Old Alice' },
        collapsed: false,
        members: [
          {
            user_id: '@alice:example.org',
            display_name: 'New Alice',
            real_name: 'New Alice',
            real_avatar_url: null,
            avatar_url: null,
            power_level: 0,
            membership: 'join',
            member_ts: null,
            kicked: false,
            service: false,
          },
        ],
      },
    },
  });
  await tick();

  expect(document.body.textContent).toContain('New Alice');
  expect(document.body.textContent).not.toContain('Old Alice');
});

test('preserves cleared room names and avatars', async () => {
  core.userProfile.mockResolvedValue({
    display_name: 'Old Alice',
    pronouns: [{ summary: 'they/them', language: null }],
  });
  render(TimelineItemHarness, {
    props: {
      core,
      item: {
        item: {
          ...replyItem(),
          sender_name: 'Old Alice',
          sender_avatar: 'mxc://example.org/old-avatar',
        },
        collapsed: false,
        members: ['@alice:example.org', '@bob:example.org'].map((user_id) => ({
          user_id,
          display_name: null,
          real_name: null,
          real_avatar_url: null,
          avatar_url: null,
          power_level: 0,
          membership: 'join' as const,
          member_ts: null,
          kicked: false,
          service: false,
        })),
      },
    },
  });
  await vi.waitFor(() => {
    expect(document.querySelector('header .sender-identity-pronoun')).toHaveTextContent(
      'they/them'
    );
  });

  expect(document.querySelector('header .sender-identity-name')).toHaveTextContent(
    '@alice:example.org'
  );
  expect(document.querySelector('.reply-name')).toHaveTextContent('@bob:example.org');
  expect(document.querySelector('.message-avatar .media-image')).toBeNull();
});

test('reopening a room does not replace the current sender with cached members', async () => {
  const loader = new RoomMemberLoader();
  const oldMember = {
    user_id: '@alice:example.org',
    display_name: 'Old Alice',
    real_name: 'Old Alice',
    real_avatar_url: 'mxc://example.org/cached-avatar',
    avatar_url: 'mxc://example.org/cached-avatar',
    power_level: 0,
    membership: 'join' as const,
    member_ts: null,
    kicked: false,
    service: false,
  };
  await loader.load('!room:example.org', () => Promise.resolve([oldMember]));
  loader.reset();
  const request = Promise.withResolvers<typeof loader.members>();
  const loading = loader.load('!room:example.org', () => request.promise);
  const message = { ...item(false), sender_name: 'New Alice', sender_avatar: null };
  const props = { core, item: { item: message, collapsed: false, members: loader.members } };
  const row = render(TimelineItemHarness, props);
  await tick();

  expect(document.querySelector('header .sender-identity-name')).toHaveTextContent('New Alice');
  expect(document.querySelector('.message-avatar .media-image')).toBeNull();

  request.resolve([{ ...oldMember, display_name: 'New Alice', avatar_url: null }]);
  await loading;
  await row.rerender({ ...props, item: { ...props.item, members: loader.members } });

  expect(document.querySelector('header .sender-identity-name')).toHaveTextContent('New Alice');
  expect(document.querySelector('.message-avatar .media-image')).toBeNull();
});

test.each([
  { name: 'Room Alice', avatar: 'mxc://example.org/room-identity' },
  { name: null, avatar: null },
])(
  'room profiles stay consistent with receipts after profile loading ($name)',
  async ({ name, avatar }) => {
    const request = Promise.withResolvers<ProfileView>();
    core.userProfile.mockReturnValue(request.promise);
    const userId = '@alice:example.org';
    const expectedName = name ?? userId;
    const cosmeticsCore = {
      rpc: {
        rooms: {
          cosmetics: vi.fn().mockResolvedValue({
            space_id: '!space:example.org',
            users: [
              {
                user_id: userId,
                color_on_light: null,
                color_on_dark: null,
                pronouns: [],
                space_display_name: 'Other Alice',
                space_avatar_url: 'mxc://example.org/other-identity',
              },
            ],
          }),
        },
      },
      subscribeEvents: () => () => {},
      userProfile: () => request.promise,
    };
    const cosmetics = new RoomCosmetics(cosmeticsCore);
    await cosmetics.load('!room:example.org', '!space:example.org');
    render(TimelineItemHarness, {
      core,
      cosmetics,
      memberUserId: userId,
      item: {
        item: {
          ...item(false),
          sender_name: name,
          sender_avatar: avatar,
          read_by: [userId],
        },
        collapsed: false,
        members: [
          {
            user_id: userId,
            display_name: name,
            real_name: name,
            real_avatar_url: avatar,
            avatar_url: avatar,
            power_level: 0,
            membership: 'join',
            member_ts: null,
            kicked: false,
            service: false,
          },
        ],
      },
    });
    await tick();
    expect(document.querySelector('header .sender-identity-name')).toHaveTextContent(expectedName);
    expect(document.querySelector('.member-name')).toHaveTextContent(expectedName);
    expect(
      within(screen.getByRole('group', { name: 'Seen by' })).getByRole('button', {
        name: expectedName,
      })
    ).toBeInTheDocument();

    request.resolve({
      user_id: userId,
      display_name: name,
      avatar_url: avatar,
      real_name: name,
      real_avatar_url: avatar,
      bio: null,
      hero_color: null,
      hero_brightness: null,
      banner_url: null,
      status: null,
      pronouns: [{ summary: 'they/them', language: null }],
      timezone: null,
      name_color_light: null,
      name_color_dark: null,
      animal: null,
      extra: [],
      supporter_awards: null,
      legacy_fields: [],
    });
    await vi.waitFor(() => {
      expect(document.querySelector('header .sender-identity-pronoun')).toHaveTextContent(
        'they/them'
      );
    });
    expect(document.querySelector('.member-identity-row .sender-identity-pronoun')).toBeNull();
    expect(document.querySelector('header .sender-identity-name')).toHaveTextContent(expectedName);
    expect(document.querySelector('.member-name')).toHaveTextContent(expectedName);
    expect(
      within(screen.getByRole('group', { name: 'Seen by' })).getByRole('button', {
        name: expectedName,
      })
    ).toBeInTheDocument();
    if (avatar) expect(core.fetchMedia).toHaveBeenCalledWith(avatar, 96, 96);
    expect(core.fetchMedia).not.toHaveBeenCalledWith('mxc://example.org/other-identity', 96, 96);
  }
);
