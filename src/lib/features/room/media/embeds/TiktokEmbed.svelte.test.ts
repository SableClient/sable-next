// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

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

afterEach(() => {
  vi.unstubAllGlobals();
});

test('a short link shows the player once oEmbed has named the post', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: () =>
        Promise.resolve({
          html: '<blockquote data-video-id="7692330011847576865"></blockquote>',
          author_url: 'https://www.tiktok.com/@rblxcatinho',
        }),
    })
  );
  const { container } = render(TiktokEmbed, {
    url: 'https://vm.tiktok.com/ZNembed1/',
    encrypted: false,
  });

  expect(await screen.findByRole('button', { name: 'Play @rblxcatinho' })).toBeInTheDocument();
  expect(container.querySelector('iframe')).not.toBeInTheDocument();
});

test('a short link oEmbed cannot resolve falls back to the link card', async () => {
  const fetchMock = vi.fn().mockResolvedValue({ ok: false, json: () => Promise.resolve({}) });
  vi.stubGlobal('fetch', fetchMock);
  render(TiktokEmbed, { url: 'https://vm.tiktok.com/ZNembed2/', encrypted: false });

  await vi.waitFor(() => {
    expect(fetchMock).toHaveBeenCalled();
  });
  await vi.waitFor(() => {
    expect(screen.queryByRole('button', { name: /^Play/ })).not.toBeInTheDocument();
  });
});
