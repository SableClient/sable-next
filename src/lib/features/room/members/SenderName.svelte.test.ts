// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import { senderDisplayColors } from './members.js';
import SenderName from './SenderName.svelte';

test('SenderName mentions and shows pronoun pills', async () => {
  const user = userEvent.setup();
  const onMention = vi.fn();
  render(SenderName, {
    displayName: 'Alice',
    colors: senderDisplayColors('@alice:example.org', null),
    pronouns: [{ summary: 'they/them', language: null }],
    onMention,
  });

  const pronoun = screen.getByText('they/them');
  expect(pronoun).toHaveClass('sender-identity-pronoun');
  expect(pronoun.closest<HTMLElement>('.sender-identity-pronouns')?.style.color).not.toBe('');
  const button = screen.getByRole('button', { name: 'Mention Alice' });
  expect(button).toHaveTextContent('Alice');
  await user.click(button);
  expect(onMention).toHaveBeenCalledTimes(1);
});

test('SenderName opens a profile when mention is unavailable', async () => {
  const user = userEvent.setup();
  const onProfile = vi.fn();
  render(SenderName, {
    displayName: 'Bob',
    colors: senderDisplayColors('@bob:example.org', null),
    onProfile,
  });

  const button = screen.getByRole('button', { name: "Open Bob's profile" });
  await user.click(button);
  expect(onProfile).toHaveBeenCalledWith(button);
});
