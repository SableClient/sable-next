// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

const core = vi.hoisted(() => ({
  userProfile: vi.fn().mockRejectedValue(new Error('profile unavailable')),
}));

vi.mock('#lib/core/context.js', () => ({
  useCoreClient: () => core,
}));

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

afterEach(() => {
  document.body.replaceChildren();
  core.userProfile.mockReset();
  core.userProfile.mockRejectedValue(new Error('profile unavailable'));
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
