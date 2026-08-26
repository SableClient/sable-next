// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { ProfileView } from '#src/generated/ProfileView';

const core = vi.hoisted(() => {
  const stub = {
    fetchMedia: vi.fn<() => Promise<Uint8Array<ArrayBuffer>>>(),
    session: { user_id: '@me:example.org' },
    createDm: vi.fn<() => Promise<string>>(),
    userRelations: vi.fn<() => Promise<{ mutualRooms: never[]; ignored: boolean }>>(),
    setUserIgnored: vi.fn<() => Promise<void>>(),
    sendMessage: vi.fn<() => Promise<void>>(),
  };

  return Object.assign(stub, { commands: stub });
});

vi.mock('#lib/core/context.js', () => ({
  useCoreClient: () => core,
}));

vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  useRoomList: () => ({ rooms: [] }),
}));

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
  expect(meta[0].textContent).toBe('she/her, iel');
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

  expect(document.querySelectorAll('.profile-card-meta .sable-skeleton')).toHaveLength(2);
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
