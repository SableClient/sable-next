// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

import ComposerLinkPreviews from './ComposerLinkPreviews.svelte';

test('each link can be dismissed on its own', async () => {
  const onDismiss = vi.fn();
  render(ComposerLinkPreviews, {
    urls: ['https://a.example/', 'https://b.example/'],
    onDismiss,
  });

  await userEvent.click(screen.getByRole('button', { name: /b\.example/ }));
  expect(onDismiss).toHaveBeenCalledExactlyOnceWith('https://b.example/');
});
