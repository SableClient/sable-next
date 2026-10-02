// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import TiktokEmbed from './TiktokEmbed.svelte';

declare const window: Window & { happyDOM: { settings: { disableIframePageLoading: boolean } } };
window.happyDOM.settings.disableIframePageLoading = true;

test('loads nothing from TikTok until the play button is pressed', async () => {
  const user = userEvent.setup();
  const { container } = render(TiktokEmbed, {
    url: 'https://www.tiktok.com/@scout2015/video/6718335390845095173',
    encrypted: false,
  });

  expect(screen.getByRole('link', { name: /@scout2015/ })).toHaveAttribute(
    'href',
    'https://www.tiktok.com/@scout2015/video/6718335390845095173'
  );
  expect(container.querySelector('iframe')).not.toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: 'Play @scout2015' }));

  expect(container.querySelector('iframe')).toHaveAttribute(
    'src',
    'https://www.tiktok.com/player/v1/6718335390845095173?autoplay=1'
  );
});
