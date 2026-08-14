// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { expect, test } from 'vitest';

import RoomReadReceipts from './RoomReadReceipts.svelte';

test('shows the people following the conversation', async () => {
  const instance = mount(RoomReadReceipts, {
    target: document.body,
    props: {
      readers: ['@bob:example.org', '@carol:example.org'],
      members: [
        { user_id: '@bob:example.org', display_name: 'Bob', avatar_url: null, power_level: 0 },
        { user_id: '@carol:example.org', display_name: 'Carol', avatar_url: null, power_level: 0 },
      ],
      loading: false,
      onMemberProfile: () => {},
    },
  });
  await tick();

  expect(document.querySelector('button')?.textContent.trim()).toBe(
    'bob, carol are following the conversation.'
  );
  expect(document.querySelector('button')?.getAttribute('title')).toBe(
    '@bob:example.org, @carol:example.org'
  );
  (document.querySelector('button') as HTMLButtonElement).click();
  await tick();
  expect(document.querySelector('.members-drawer')?.textContent).toContain('Bob');
  expect(document.querySelector('.members-drawer')?.textContent).toContain('Carol');
  document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }));
  await tick();
  await unmount(instance);
});
