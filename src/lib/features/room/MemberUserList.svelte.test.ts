// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js', () => ({
  useCoreClient: () => ({
    userProfile: vi.fn().mockRejectedValue(new Error('profile unavailable')),
  }),
}));

import MemberUserList from './MemberUserList.svelte';

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
  {
    user_id: '@carol:example.org',
    display_name: 'Carol',
    avatar_url: null,
    power_level: 0,
    membership: 'join' as const,
    member_ts: null,
    kicked: false,
  },
];

afterEach(() => {
  document.body.replaceChildren();
});

test('renders readers in order and closes from the header', async () => {
  const onClose = vi.fn();
  const instance = mount(MemberUserList, {
    target: document.body,
    props: {
      title: 'Seen by',
      userIds: ['@bob:example.org', '@carol:example.org'],
      members,
      onMemberProfile: vi.fn(),
      onClose,
    },
  });
  await tick();

  expect(document.querySelector('.member-user-list')?.textContent).toContain('Bob');
  expect(document.querySelector('.member-user-list')?.textContent).toContain('Carol');
  (document.querySelector('[aria-label="Close members"]') as HTMLButtonElement).click();
  expect(onClose).toHaveBeenCalledTimes(1);
  await unmount(instance);
});
