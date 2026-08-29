// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { expect, test, vi } from 'vitest';

import type { PollView } from '#src/generated/PollView';

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

function render(props: Record<string, unknown>) {
  const target = document.createElement('div');
  document.body.append(target);
  const component = mount(TimelinePoll, {
    target,
    props: { poll: poll(), eventId: '$poll', canEnd: false, ...props },
  });
  return {
    target,
    answers: () => [...target.querySelectorAll<HTMLButtonElement>('.answer')],
    cleanup: () => {
      void unmount(component);
      target.remove();
    },
  };
}

test('a single-choice vote replaces the selection', async () => {
  const onVote = vi.fn();
  const view = render({ onVote });
  await tick();

  view.answers()[1].click();
  await tick();

  expect(onVote).toHaveBeenCalledWith('$poll', ['1']);
  view.cleanup();
});

test('clicking the answer already picked withdraws the vote', async () => {
  const onVote = vi.fn();
  const answers = poll().answers.map((answer, index) => ({ ...answer, selected: index === 0 }));
  const view = render({ poll: poll({ answers }), onVote });
  await tick();

  view.answers()[0].click();
  await tick();

  expect(onVote).toHaveBeenCalledWith('$poll', []);
  view.cleanup();
});

test('a multi-choice poll adds to the selection and stops at the cap', async () => {
  const onVote = vi.fn();
  const answers = poll().answers.map((answer, index) => ({ ...answer, selected: index === 0 }));
  const view = render({ poll: poll({ answers, max_selections: 2 }), onVote });
  await tick();

  view.answers()[1].click();
  await tick();
  expect(onVote).toHaveBeenCalledWith('$poll', ['0', '1']);

  onVote.mockClear();
  const full = poll({
    answers: poll().answers.map((answer) => ({ ...answer, selected: true })),
    max_selections: 2,
  });
  const capped = render({ poll: full, onVote });
  await tick();
  // Both are picked, so a third click has nothing left to add.
  capped.answers()[0].click();
  await tick();
  expect(onVote).toHaveBeenCalledWith('$poll', ['1']);

  view.cleanup();
  capped.cleanup();
});

test('a closed poll accepts no vote and offers no close button', async () => {
  const onVote = vi.fn();
  const view = render({ poll: poll({ ended_at: 1000 }), onVote, canEnd: true });
  await tick();

  expect(view.answers().every((button) => button.disabled)).toBe(true);
  view.answers()[0].click();
  await tick();

  expect(onVote).not.toHaveBeenCalled();
  expect(view.target.querySelector('.end')).toBeNull();
  view.cleanup();
});

test('a local echo cannot be voted on', async () => {
  const onVote = vi.fn();
  const view = render({ eventId: null, onVote });
  await tick();

  expect(view.answers().every((button) => button.disabled)).toBe(true);
  view.cleanup();
});

test('an undisclosed poll shows no tally', async () => {
  const answers = poll().answers.map((answer) => ({ ...answer, votes: null }));
  const view = render({ poll: poll({ answers, undisclosed: true }) });
  await tick();

  expect(view.target.querySelector('.count')).toBeNull();
  view.cleanup();
});

test('a null voters list shows the vote count with no affordance to open it', async () => {
  const view = render({});
  await tick();

  expect(view.target.querySelector('.count-button')).toBeNull();
  expect(view.target.querySelector('.count')?.textContent).toContain('3 votes');
  view.cleanup();
});

test('tapping a vote count with voters opens the voters dialog', async () => {
  const answers = poll().answers.map((answer) => ({
    ...answer,
    voters: answer.id === '0' ? ['@alice:example.org', '@bob:example.org'] : ['@carol:example.org'],
  }));
  const view = render({ poll: poll({ answers }) });
  await tick();

  view.target.querySelector<HTMLButtonElement>('.count-button')?.click();
  await tick();

  const dialog = document.body.querySelector('[role="tablist"]');
  expect(dialog).not.toBeNull();
  expect(document.body.textContent).toContain('alice');
  view.cleanup();
});

test('the close button reaches the handler only when allowed', async () => {
  const onEnd = vi.fn();
  const view = render({ canEnd: true, onEnd });
  await tick();

  view.target.querySelector<HTMLButtonElement>('.end')?.click();
  await tick();

  expect(onEnd).toHaveBeenCalledWith('$poll');
  view.cleanup();
});
