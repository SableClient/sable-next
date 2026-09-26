// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import RoomPredecessorNotice from './RoomPredecessorNotice.svelte';

test('says the room continues another and opens it', async () => {
  const user = userEvent.setup();
  const onOpen = vi.fn();
  render(RoomPredecessorNotice, { onOpen });

  expect(
    screen.getByText('This room is a continuation of another conversation.')
  ).toBeInTheDocument();
  await user.click(screen.getByRole('button', { name: 'View older messages' }));

  expect(onOpen).toHaveBeenCalledOnce();
});
