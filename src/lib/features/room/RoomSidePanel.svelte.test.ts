// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { createRawSnippet } from 'svelte';
import { expect, test, vi } from 'vitest';

import RoomSidePanel from './RoomSidePanel.svelte';

function panel(onClose: () => void) {
  render(RoomSidePanel, {
    props: {
      title: 'Search',
      closeLabel: 'Close search',
      resizeLabel: 'Resize search',
      widthKey: 'test-width',
      icon: createRawSnippet(() => ({ render: () => '<span></span>' })),
      children: createRawSnippet(() => ({ render: () => '<input aria-label="Query" />' })),
      onClose,
    },
  });
}

test('Escape inside a side panel closes it', async () => {
  const onClose = vi.fn();
  panel(onClose);

  await userEvent.click(screen.getByLabelText('Query'));
  await userEvent.keyboard('{Escape}');

  expect(onClose).toHaveBeenCalledTimes(1);
});

test('Escape outside a side panel leaves it open', async () => {
  const onClose = vi.fn();
  panel(onClose);

  document.body.focus();
  await userEvent.keyboard('{Escape}');

  expect(onClose).not.toHaveBeenCalled();
});
