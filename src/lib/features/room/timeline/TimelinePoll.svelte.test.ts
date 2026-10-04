// @vitest-environment happy-dom

import { render, screen, within } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

vi.mock('#lib/rooms/presence.svelte.js', async () => {
  const actual = await vi.importActual<typeof import('#lib/rooms/presence.svelte.js')>(
    '#lib/rooms/presence.svelte.js'
  );
  return { ...actual, usePresenceStore: () => ({ get: () => null, peek: () => null }) };
});

import type { PollView } from '#src/generated/protocol';

import TimelinePoll from './TimelinePoll.svelte';

function poll(overrides: Partial<PollView> = {}): PollView {
  return {
    question: 'lunch?',
    answers: [
      { id: '0', text: 'ramen', votes: 3, selected: false, voters: null },
      { id: '1', text: 'curry', votes: 1, selected: false, voters: null },
    ],
    max_selections: 1,
    undisclosed: false,
    ended_at: null,
    edited: false,
    ...overrides,
  };
}

function setup(props: Record<string, unknown>) {
  const view = render(TimelinePoll, { poll: poll(), eventId: '$poll', canEnd: false, ...props });
  return {
    user: userEvent.setup(),
    answer: (text: string) =>
      within(view.container).getByRole('button', { name: new RegExp(text) }),
    answers: () =>
      within(view.container)
        .getAllByRole('button')
        .filter((button) => button.classList.contains('answer')),
    container: view.container,
  };
}

test('a single-choice vote replaces the selection', async () => {
  const onVote = vi.fn();
  const view = setup({ onVote });

  await view.user.click(view.answer('curry'));

  expect(onVote).toHaveBeenCalledWith('$poll', ['1']);
});

test('clicking the answer already picked withdraws the vote', async () => {
  const onVote = vi.fn();
  const answers = poll().answers.map((answer, index) => ({ ...answer, selected: index === 0 }));
  const view = setup({ poll: poll({ answers }), onVote });

  expect(view.answer('ramen')).toHaveAttribute('aria-pressed', 'true');
  await view.user.click(view.answer('ramen'));

  expect(onVote).toHaveBeenCalledWith('$poll', []);
});

test('a multi-choice poll adds to the selection and stops at the cap', async () => {
  const onVote = vi.fn();
  const answers = poll().answers.map((answer, index) => ({ ...answer, selected: index === 0 }));
  const view = setup({ poll: poll({ answers, max_selections: 2 }), onVote });

  await view.user.click(view.answer('curry'));
  expect(onVote).toHaveBeenCalledWith('$poll', ['0', '1']);

  onVote.mockClear();
  const full = poll({
    answers: poll().answers.map((answer) => ({ ...answer, selected: true })),
    max_selections: 2,
  });
  const capped = setup({ poll: full, onVote });
  // Both are picked, so a third click has nothing left to add.
  await capped.user.click(capped.answer('ramen'));
  expect(onVote).toHaveBeenCalledWith('$poll', ['1']);
});

test('a closed poll accepts no vote and offers no close button', async () => {
  const onVote = vi.fn();
  const view = setup({ poll: poll({ ended_at: 1000 }), onVote, canEnd: true });

  for (const answer of view.answers()) expect(answer).toBeDisabled();
  await view.user.click(view.answer('ramen'));

  expect(onVote).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'Close poll' })).not.toBeInTheDocument();
});

test('a local echo cannot be voted on', () => {
  const view = setup({ eventId: null, onVote: vi.fn() });

  for (const answer of view.answers()) expect(answer).toBeDisabled();
});

test('an undisclosed poll shows no tally', () => {
  const answers = poll().answers.map((answer) => ({ ...answer, votes: null }));
  const view = setup({ poll: poll({ answers, undisclosed: true }) });

  expect(view.container.querySelector('.count')).not.toBeInTheDocument();
});

test('a null voters list shows the vote count with no affordance to open it', () => {
  setup({});

  expect(screen.queryByRole('button', { name: /See who voted/ })).not.toBeInTheDocument();
  expect(screen.getByText('3 votes')).toBeInTheDocument();
});

test('tapping a vote count with voters opens the voters dialog', async () => {
  const answers = poll().answers.map((answer) => ({
    ...answer,
    voters: answer.id === '0' ? ['@alice:example.org', '@bob:example.org'] : ['@carol:example.org'],
  }));
  const view = setup({ poll: poll({ answers }) });

  await view.user.click(screen.getByRole('button', { name: 'See who voted for "ramen"' }));

  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByRole('tablist')).toBeInTheDocument();
  expect(dialog).toHaveTextContent('alice');
});

test('a voters tab switches the list to that answer', async () => {
  const answers = poll().answers.map((answer) => ({
    ...answer,
    voters: answer.id === '0' ? ['@alice:example.org'] : ['@carol:example.org'],
  }));
  const view = setup({ poll: poll({ answers }) });

  await view.user.click(screen.getByRole('button', { name: 'See who voted for "ramen"' }));

  const dialog = await screen.findByRole('dialog');
  const tabs = within(dialog).getAllByRole('tab');
  expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['true', 'false']);

  await view.user.click(tabs[1]);

  expect(tabs.map((tab) => tab.getAttribute('aria-selected'))).toEqual(['false', 'true']);
  const list = within(dialog).getByRole('list');
  expect(list).toHaveTextContent('carol');
  expect(list).not.toHaveTextContent('alice');
});

test('the close button reaches the handler only when allowed', async () => {
  const onEnd = vi.fn();
  const view = setup({ canEnd: true, onEnd });

  await view.user.click(screen.getByRole('button', { name: 'Close poll' }));

  expect(onEnd).toHaveBeenCalledWith('$poll');
});
