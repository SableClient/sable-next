// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import PollComposer from './PollComposer.svelte';

test('removing an answer keeps the others and their order', async () => {
  const onCreate = vi.fn();
  const user = userEvent.setup();
  render(PollComposer, { open: true, onCreate });

  await user.type(screen.getByRole('textbox', { name: 'Question' }), 'Lunch?');
  await user.click(screen.getByRole('button', { name: 'Add answer' }));
  await user.type(screen.getByRole('textbox', { name: 'Answer 1' }), 'Soup');
  await user.type(screen.getByRole('textbox', { name: 'Answer 2' }), 'Salad');
  await user.type(screen.getByRole('textbox', { name: 'Answer 3' }), 'Pizza');

  const pizza = screen.getByRole('textbox', { name: 'Answer 3' });
  await user.click(screen.getByRole('button', { name: 'Remove answer 2' }));

  expect(screen.getByRole('textbox', { name: 'Answer 1' })).toHaveValue('Soup');
  expect(screen.getByRole('textbox', { name: 'Answer 2' })).toBe(pizza);
  expect(pizza).toHaveValue('Pizza');
  expect(screen.queryByRole('textbox', { name: 'Answer 3' })).not.toBeInTheDocument();

  expect(
    screen.getByRole('spinbutton', { name: 'How many options may one person pick' })
  ).toHaveValue(1);

  await user.click(screen.getByRole('button', { name: 'Create poll' }));

  expect(onCreate).toHaveBeenCalledWith('Lunch?', ['Soup', 'Pizza'], false, 1);
});
