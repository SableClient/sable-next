// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import TypingIndicator from './TypingIndicator.svelte';

const users = ['Alice', 'Bob', 'Charlie', 'Dana'].map((name) => ({
  userId: `@${name.toLowerCase()}:example.org`,
  name,
}));

test.each([
  [1, 'Alice is typing…', 1],
  [2, 'Alice and Bob are typing…', 2],
  [3, 'Alice, Bob and Charlie are typing…', 3],
  [4, 'Alice, Bob and 2 others are typing…', 2],
])('opens each displayed profile with %i typing users', async (count, label, buttons) => {
  const user = userEvent.setup();
  const onProfile = vi.fn();
  render(TypingIndicator, { users: users.slice(0, count), onProfile });

  expect(screen.getByRole('status')).toHaveTextContent(label);
  const names = screen.getAllByRole('button');
  expect(names).toHaveLength(buttons);
  for (const [index, name] of names.entries()) {
    await user.click(name);
    expect(onProfile).toHaveBeenLastCalledWith(users[index].userId, name);
  }
});

test('opens the correct profile by keyboard when names are identical', async () => {
  const user = userEvent.setup();
  const onProfile = vi.fn();
  render(TypingIndicator, {
    users: users.slice(0, 2).map((entry) => ({ ...entry, name: 'Alice & Bob' })),
    onProfile,
  });

  const names = screen.getAllByRole('button');
  await user.tab();
  await user.keyboard('{Enter}');
  expect(onProfile).toHaveBeenLastCalledWith(users[0].userId, names[0]);
  await user.tab();
  await user.keyboard(' ');
  expect(onProfile).toHaveBeenLastCalledWith(users[1].userId, names[1]);
  expect(names[0]).toHaveTextContent('Alice & Bob');
});

test('shows the fallback for unknown names', () => {
  render(TypingIndicator, {
    users: [users[0], { ...users[1], name: null }],
    onProfile: vi.fn(),
  });

  expect(screen.getByRole('status')).toHaveTextContent('Someone is typing…');
  expect(screen.queryByRole('button')).not.toBeInTheDocument();
});

test('renders no indicator without typing users', () => {
  render(TypingIndicator, { users: [], onProfile: vi.fn() });

  expect(screen.getByRole('status')).toBeEmptyDOMElement();
});
