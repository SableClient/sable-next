// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import MembersDrawer from './MembersDrawer.svelte';

afterEach(() => {
  document.body.replaceChildren();
});

test('sorts members by power then name and opens their profile', async () => {
  const onMemberProfile = vi.fn();
  const instance = mount(MembersDrawer, {
    target: document.body,
    props: {
      loading: false,
      members: [
        { user_id: '@zoe:example.org', display_name: 'Zoe', avatar_url: null, power_level: 0 },
        { user_id: '@bob:example.org', display_name: 'Bob', avatar_url: null, power_level: 100 },
        { user_id: '@amy:example.org', display_name: 'Amy', avatar_url: null, power_level: 100 },
      ],
      onClose: vi.fn(),
      onMemberProfile,
    },
  });
  await tick();

  const members = [...document.querySelectorAll<HTMLButtonElement>('.member')];
  expect(members.map((member) => member.querySelector('.name')?.textContent)).toEqual([
    'Amy',
    'Bob',
    'Zoe',
  ]);
  members[0]?.click();
  expect(onMemberProfile).toHaveBeenCalledWith('@amy:example.org', members[0]);
  await unmount(instance);
});
