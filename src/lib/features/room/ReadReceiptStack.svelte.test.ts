// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { expect, test } from 'vitest';

import ReadReceiptStack from './ReadReceiptStack.svelte';

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

test('names every reader and reports the open dialog', async () => {
  let anchor: HTMLButtonElement | null = null;
  const instance = mount(ReadReceiptStack, {
    target: document.body,
    props: {
      readers: ['@bob:example.org', '@carol:example.org'],
      members,
      onOpen: (element: HTMLButtonElement) => {
        anchor = element;
      },
    },
  });
  await tick();

  const trigger = document.querySelector('button') as HTMLButtonElement;
  expect(trigger.getAttribute('aria-label')).toBe('Seen by Bob, Carol. Open the list.');
  expect(trigger.getAttribute('aria-haspopup')).toBe('dialog');
  expect(trigger.getAttribute('aria-expanded')).toBe('false');
  expect(trigger.getAttribute('title')).toBe('Bob, Carol');
  expect(trigger.querySelectorAll('.sable-avatar')).toHaveLength(2);
  expect(trigger.querySelector('.overflow')).toBeNull();

  trigger.click();
  expect(anchor).toBe(trigger);

  await unmount(instance);
});

test('caps the stack at three faces and renders nothing without readers', async () => {
  const many = Array.from({ length: 12 }, (_, index) => `@user${String(index)}:example.org`);
  const instance = mount(ReadReceiptStack, {
    target: document.body,
    props: {
      readers: many,
      members: many.map((user_id) => ({
        user_id,
        display_name: user_id,
        avatar_url: null,
        power_level: 0,
        membership: 'join' as const,
        member_ts: null,
        kicked: false,
      })),
      onOpen: () => {},
    },
  });
  await tick();

  expect(document.querySelectorAll('.stack .sable-avatar')).toHaveLength(3);
  expect(document.querySelector('.overflow')?.textContent).toBe('+9');

  await unmount(instance);

  const empty = mount(ReadReceiptStack, {
    target: document.body,
    props: { readers: [], members: [], onOpen: () => {} },
  });
  await tick();

  expect(document.querySelector('.read-receipt-stack')).toBeNull();

  await unmount(empty);
});
