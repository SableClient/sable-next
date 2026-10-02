// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import InstagramEmbed from './InstagramEmbed.svelte';

declare const window: Window & { happyDOM: { settings: { disableIframePageLoading: boolean } } };
window.happyDOM.settings.disableIframePageLoading = true;

test('loads nothing from Instagram until the button is pressed', async () => {
  const user = userEvent.setup();
  const { container } = render(InstagramEmbed, {
    url: 'https://www.instagram.com/reel/CxYz_123-ab/',
    encrypted: false,
  });

  expect(screen.getByRole('link', { name: /Reel/ })).toHaveAttribute(
    'href',
    'https://www.instagram.com/reel/CxYz_123-ab/'
  );
  expect(container.querySelector('iframe')).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Show Instagram' }));

  expect(container.querySelector('iframe')).toHaveAttribute(
    'src',
    'https://www.instagram.com/reel/CxYz_123-ab/embed/'
  );
});
