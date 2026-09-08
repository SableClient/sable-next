// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

const core = vi.hoisted(() => ({
  userProfile: vi.fn().mockRejectedValue(new Error('profile unavailable')),
}));

const presence = vi.hoisted(() => ({ entry: null as { statusMessage: string | null } | null }));

vi.mock('#lib/core/context.js', () => ({
  useCoreClient: () => core,
}));

vi.mock('#lib/rooms/presence.svelte.js', async () => {
  const actual = await vi.importActual<typeof import('#lib/rooms/presence.svelte.js')>(
    '#lib/rooms/presence.svelte.js'
  );
  return { ...actual, usePresenceStore: () => ({ get: () => presence.entry }) };
});

import MemberIdentityRow from './MemberIdentityRow.svelte';

const members = [
  {
    user_id: '@bob:example.org',
    display_name: 'Bob',
    avatar_url: null,
    power_level: 0,
    membership: 'join' as const,
    member_ts: null,
    kicked: false,
  },
];

function profileFor(userId: string) {
  return {
    user_id: userId,
    display_name: 'Bob',
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
}

afterEach(() => {
  document.body.replaceChildren();
  core.userProfile.mockReset();
  core.userProfile.mockRejectedValue(new Error('profile unavailable'));
  presence.entry = null;
});

test('tints the name from the profile and opens the profile card from the row', async () => {
  core.userProfile.mockResolvedValue({
    user_id: '@bob:example.org',
    display_name: 'Bob',
    avatar_url: null,
    bio: null,
    hero_color: null,
    hero_brightness: null,
    banner_url: null,
    status: null,
    pronouns: [{ summary: 'he/him', language: null }],
    timezone: null,
    name_color_light: '#4f7a3a',
    name_color_dark: '#9fd07c',
    animal: null,
    extra: [],
  });
  const onProfile = vi.fn();
  const instance = mount(MemberIdentityRow, {
    target: document.body,
    props: {
      userId: '@bob:example.org',
      members,
      onProfile,
    },
  });
  await tick();
  await tick();

  expect(document.querySelector('.member-name')?.classList.contains('tinted')).toBe(true);
  expect(document.querySelector('.sable-pronoun-pill')).toBeNull();
  const row = document.querySelector<HTMLButtonElement>('.member-identity-button');
  row?.click();
  expect(onProfile).toHaveBeenCalledWith('@bob:example.org', row);
  await unmount(instance);
});

async function mountRow(props: Record<string, unknown>) {
  const instance = mount(MemberIdentityRow, {
    target: document.body,
    props: { userId: '@bob:example.org', members, ...props },
  });
  await tick();
  await tick();
  return instance;
}

test('shows the profile status, emoji first', async () => {
  core.userProfile.mockResolvedValue({
    ...profileFor('@bob:example.org'),
    status: { text: 'Shipping', emoji: '\u{1F680}' },
  });
  const instance = await mountRow({ showStatus: true });

  expect(document.querySelector('.member-identity-status')?.textContent.trim()).toBe(
    '\u{1F680}Shipping'
  );
  await unmount(instance);
});

test('falls back to the presence message when the profile has no status', async () => {
  core.userProfile.mockResolvedValue({ ...profileFor('@bob:example.org'), status: null });
  presence.entry = { statusMessage: 'In a meeting' };
  const instance = await mountRow({ showStatus: true });

  expect(document.querySelector('.member-identity-status')?.textContent.trim()).toBe(
    'In a meeting'
  );
  await unmount(instance);
});

test('leaves the status out unless the row asks for it', async () => {
  core.userProfile.mockResolvedValue({
    ...profileFor('@bob:example.org'),
    status: { text: 'Shipping', emoji: null },
  });
  const instance = await mountRow({});

  expect(document.querySelector('.member-identity-status')).toBeNull();
  await unmount(instance);
});
