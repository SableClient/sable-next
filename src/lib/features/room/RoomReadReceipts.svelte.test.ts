// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { expect, test } from 'vitest';

import RoomReadReceipts from './RoomReadReceipts.svelte';

const members = [
  { user_id: '@bob:example.org', display_name: 'Bob', avatar_url: null, power_level: 0 },
  { user_id: '@carol:example.org', display_name: 'Carol', avatar_url: null, power_level: 0 },
];

test('shows a face stack and opens the seen-by list', async () => {
  const instance = mount(RoomReadReceipts, {
    target: document.body,
    props: {
      readers: ['@bob:example.org', '@carol:example.org'],
      members,
      loading: false,
      onMemberProfile: () => {},
    },
  });
  await tick();

  const trigger = document.querySelector('button') as HTMLButtonElement;
  expect(trigger.getAttribute('aria-label')).toBe('Seen by Bob, Carol. Open the list.');
  expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(trigger.getAttribute('title')).toBe('Bob, Carol');
  expect(trigger.querySelectorAll('.sable-avatar')).toHaveLength(2);
  expect(trigger.querySelector('.count')?.textContent).toBe('2');

  trigger.click();
  await tick();
  expect(document.querySelector('button')?.getAttribute('aria-expanded')).toBe('true');
  expect(document.querySelector('.members-drawer')?.textContent).toContain('Bob');
  expect(document.querySelector('.members-drawer')?.textContent).toContain('Carol');
  (document.querySelector('[aria-label="Close members"]') as HTMLButtonElement).click();
  await tick();

  await unmount(instance);
});

test('caps the stack at three faces and keeps the row reserved when empty', async () => {
  const many = Array.from({ length: 12 }, (_, index) => `@user${String(index)}:example.org`);
  const instance = mount(RoomReadReceipts, {
    target: document.body,
    props: {
      readers: many,
      members: many.map((user_id) => ({
        user_id,
        display_name: user_id,
        avatar_url: null,
        power_level: 0,
      })),
      loading: false,
      onMemberProfile: () => {},
    },
  });
  await tick();

  expect(document.querySelectorAll('.stack .sable-avatar')).toHaveLength(3);
  expect(document.querySelector('.count')?.textContent).toBe('12');

  await unmount(instance);

  const empty = mount(RoomReadReceipts, {
    target: document.body,
    props: { readers: [], members: [], loading: false, onMemberProfile: () => {} },
  });
  await tick();

  expect(document.querySelector('.room-read-receipts')?.children).toHaveLength(0);

  await unmount(empty);
});

test('hides the trigger when not visible but keeps the row reserved', async () => {
  const instance = mount(RoomReadReceipts, {
    target: document.body,
    props: {
      readers: ['@bob:example.org'],
      members,
      loading: false,
      visible: false,
      onMemberProfile: () => {},
    },
  });
  await tick();

  expect(document.querySelector('.room-read-receipts')).not.toBeNull();
  expect(document.querySelector('.room-read-receipts')?.children).toHaveLength(0);

  await unmount(instance);
});
