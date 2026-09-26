// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
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
    service: false,
  },
  {
    user_id: '@carol:example.org',
    display_name: 'Carol',
    avatar_url: null,
    power_level: 0,
    membership: 'join' as const,
    member_ts: null,
    kicked: false,
    service: false,
  },
];

test('names every reader and reports the open dialog', async () => {
  const user = userEvent.setup();
  let anchor: HTMLButtonElement | null = null;
  render(ReadReceiptStack, {
    readers: ['@bob:example.org', '@carol:example.org'],
    members,
    onOpen: (element: HTMLButtonElement) => {
      anchor = element;
    },
  });

  const trigger = screen.getByRole('button', { name: 'Seen by Bob, Carol. Open the list.' });
  expect(trigger).toHaveAttribute('aria-haspopup', 'dialog');
  expect(trigger).toHaveAttribute('aria-expanded', 'false');
  expect(trigger).toHaveAttribute('title', 'Bob, Carol');
  expect(trigger.querySelectorAll('.avatar-root')).toHaveLength(2);
  expect(trigger.querySelector('.overflow')).not.toBeInTheDocument();

  await user.click(trigger);
  expect(anchor).toBe(trigger);
});

test('caps the stack at three faces and renders nothing without readers', () => {
  const many = Array.from({ length: 12 }, (_, index) => `@user${String(index)}:example.org`);
  const instance = render(ReadReceiptStack, {
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
        service: false,
      })),
      onOpen: () => {},
    },
  });

  const trigger = screen.getByRole('button');
  expect(trigger.querySelectorAll('.stack .avatar-root')).toHaveLength(3);
  expect(trigger).toHaveTextContent('+9');

  instance.unmount();

  render(ReadReceiptStack, { readers: [], members: [], onOpen: () => {} });

  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});
