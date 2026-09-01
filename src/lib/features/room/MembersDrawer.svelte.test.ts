// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js', () => ({
  useCoreClient: () => ({
    userProfile: vi.fn().mockRejectedValue(new Error('profile unavailable')),
  }),
}));

import { setPreference } from '#lib/settings/preferences.svelte.js';

import MembersDrawer from './MembersDrawer.svelte';

afterEach(() => {
  document.body.replaceChildren();
  setPreference('memberSort', 'name-asc');
});

test('sorts members by power then name and opens their profile', async () => {
  const onMemberProfile = vi.fn();
  const instance = mount(MembersDrawer, {
    target: document.body,
    props: {
      loading: false,
      members: [
        {
          user_id: '@zoe:example.org',
          display_name: 'Zoe',
          avatar_url: null,
          power_level: 0,
          membership: 'join' as const,
          member_ts: null,
          kicked: false,
        },
        {
          user_id: '@bob:example.org',
          display_name: 'Bob',
          avatar_url: null,
          power_level: 100,
          membership: 'join' as const,
          member_ts: null,
          kicked: false,
        },
        {
          user_id: '@amy:example.org',
          display_name: 'Amy',
          avatar_url: null,
          power_level: 100,
          membership: 'join' as const,
          member_ts: null,
          kicked: false,
        },
      ],
      onClose: vi.fn(),
      onMemberProfile,
    },
  });
  await tick();

  const members = [
    ...document.querySelectorAll<HTMLButtonElement>('.member.member-identity-button'),
  ];
  expect(members.map((member) => member.querySelector('.member-name')?.textContent)).toEqual([
    'Amy',
    'Bob',
    'Zoe',
  ]);
  members[0]?.click();
  expect(onMemberProfile).toHaveBeenCalledWith('@amy:example.org', members[0]);
  await unmount(instance);
});

test('honours the sort preference and fetches the membership a filter names', async () => {
  setPreference('memberSort', 'name-desc');
  const loadMembership = vi.fn(() => Promise.resolve([]));
  const instance = mount(MembersDrawer, {
    target: document.body,
    props: {
      loading: false,
      members: [
        {
          user_id: '@zoe:example.org',
          display_name: 'Zoe',
          avatar_url: null,
          power_level: 0,
          membership: 'join' as const,
          member_ts: null,
          kicked: false,
        },
        {
          user_id: '@amy:example.org',
          display_name: 'Amy',
          avatar_url: null,
          power_level: 0,
          membership: 'join' as const,
          member_ts: null,
          kicked: false,
        },
      ],
      loadMembership,
      onClose: vi.fn(),
      onMemberProfile: vi.fn(),
    },
  });
  await tick();

  const names = [...document.querySelectorAll('.member .member-name')].map(
    (node) => node.textContent
  );
  expect(names).toEqual(['Zoe', 'Amy']);
  expect(loadMembership).not.toHaveBeenCalled();
  await unmount(instance);
});
