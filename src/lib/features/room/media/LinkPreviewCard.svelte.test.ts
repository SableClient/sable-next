// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { UrlPreviewView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');
vi.mock('#lib/config/runtime-config.js', () => ({
  runtimeConfig: () =>
    Promise.resolve({
      embeds: { serviceUrl: 'https://embeds.test' },
      gifs: { klipyApiKey: null },
    }),
}));

import { core as baseCore } from '#lib/core/__mocks__/context.js';

const core = baseCore;
Object.assign(core.rpc.messages, {
  urlPreview:
    vi.fn<(params: { url: string; service: string | null }) => Promise<UrlPreviewView | null>>(),
});

import LinkPreviewCard from './LinkPreviewCard.svelte';
import LinkPreviewCardMediaHarness from './LinkPreviewCardMediaHarness.test.svelte';
import LinkPreviewCardTooltipHarness from './LinkPreviewCardTooltipHarness.test.svelte';
import { previewWhitelistEntry } from './link-preview.js';
import { mediaPreviewSettings } from '#lib/settings/media-previews.svelte.js';
import { preferences } from '#lib/settings/preferences.svelte.js';
import { mediaViewerState } from '#lib/ui/media/media-viewer-state.svelte.js';

function preview(overrides: Partial<UrlPreviewView> = {}): UrlPreviewView {
  return {
    url: 'https://example.org/a',
    title: 'Example',
    description: null,
    site_name: null,
    image: null,
    image_mime: null,
    image_width: null,
    image_height: null,
    video: null,
    theme_color: null,
    card: null,
    author_name: null,
    post: null,
    ...overrides,
  };
}

afterEach(() => {
  core.rpc.messages.urlPreview.mockReset();
  preferences.urlPreviews = false;
  preferences.encryptedUrlPreviews = false;
  preferences.clientEmbeds = false;
  preferences.encryptedClientEmbeds = false;
  preferences.autoplayGifs = true;
  vi.restoreAllMocks();
  mediaViewerState.close();
});

test('renders the resolved preview as a link', async () => {
  preferences.urlPreviews = true;
  core.rpc.messages.urlPreview.mockResolvedValue(preview({ url: 'https://example.org/render' }));
  render(LinkPreviewCard, {
    url: 'https://example.org/render',
    encrypted: false,
  });

  await tick();
  await Promise.resolve();
  await tick();

  const link = screen.getByRole('link', { name: /Example/ });
  expect(link).toHaveAttribute('href', 'https://example.org/render');
  expect(link.parentElement).toHaveClass('link-preview');
});

test('a second card for the same url does not re-request it', async () => {
  preferences.urlPreviews = true;
  core.rpc.messages.urlPreview.mockResolvedValue(preview({ url: 'https://example.org/cached' }));
  const first = render(LinkPreviewCard, {
    url: 'https://example.org/cached',
    encrypted: false,
  });
  await tick();
  await Promise.resolve();
  await tick();
  first.unmount();

  render(LinkPreviewCard, {
    url: 'https://example.org/cached',
    encrypted: false,
  });
  await tick();
  await Promise.resolve();
  await tick();

  expect(core.rpc.messages.urlPreview).toHaveBeenCalledTimes(1);
});

test('an in-flight request does not write into a torn-down component', async () => {
  preferences.urlPreviews = true;
  let resolve: (value: UrlPreviewView | null) => void = () => {};
  core.rpc.messages.urlPreview.mockReturnValue(
    new Promise((res) => {
      resolve = res;
    })
  );
  const instance = render(LinkPreviewCard, {
    url: 'https://example.org/b',
    encrypted: false,
  });
  await tick();

  instance.unmount();
  expect(() => {
    resolve(preview({ url: 'https://example.org/b' }));
  }).not.toThrow();
  await tick();
});

test('renders no bundled preview while url previews are disabled', () => {
  preferences.urlPreviews = false;
  render(LinkPreviewCard, {
    url: 'https://example.org/c',
    encrypted: false,
    bundled: preview({ url: 'https://example.org/c' }),
  });

  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});

test.each([false, true])(
  'bundled previews render with encrypted server lookups=%s',
  async (server) => {
    preferences.urlPreviews = !server;
    preferences.encryptedUrlPreviews = server;
    render(LinkPreviewCard, {
      url: 'https://example.org/bundled-encrypted',
      encrypted: true,
      bundled: preview({ url: 'https://example.org/bundled-encrypted' }),
    });
    await tick();

    expect(screen.getByRole('link', { name: 'Example' })).toBeInTheDocument();
    expect(core.rpc.messages.urlPreview).not.toHaveBeenCalled();
  }
);

test('a whitelist-only preview fetches metadata', async () => {
  preferences.urlPreviews = true;
  const url = 'https://example.org/whitelisted';
  core.rpc.messages.urlPreview.mockResolvedValue(preview({ url }));
  render(LinkPreviewCard, { url, encrypted: false, bundled: previewWhitelistEntry(url) });
  await vi.waitFor(() => {
    expect(screen.getByRole('link', { name: 'Example' })).toBeInTheDocument();
  });
  expect(core.rpc.messages.urlPreview).toHaveBeenCalledWith({ url, service: null });
});

test('a whitelist-only preview in an encrypted room still requires consent', async () => {
  preferences.urlPreviews = true;
  const url = 'https://example.org/whitelisted-private';
  render(LinkPreviewCard, { url, encrypted: true, bundled: previewWhitelistEntry(url) });
  await tick();

  expect(core.rpc.messages.urlPreview).not.toHaveBeenCalled();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});

test('does nothing while url previews are disabled', async () => {
  preferences.urlPreviews = false;
  core.rpc.messages.urlPreview.mockResolvedValue(preview());
  render(LinkPreviewCard, { url: 'https://example.org/c', encrypted: false });

  await tick();
  await Promise.resolve();
  await tick();

  expect(core.rpc.messages.urlPreview).not.toHaveBeenCalled();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});

test('an encrypted room needs its own consent, and an unknown one is treated as encrypted', async () => {
  preferences.urlPreviews = true;
  core.rpc.messages.urlPreview.mockResolvedValue(preview());
  const encrypted = render(LinkPreviewCard, {
    url: 'https://example.org/d',
    encrypted: true,
  });
  const unknown = render(LinkPreviewCard, {
    url: 'https://example.org/e',
    encrypted: null,
  });

  await tick();
  await Promise.resolve();
  await tick();

  expect(core.rpc.messages.urlPreview).not.toHaveBeenCalled();
  encrypted.unmount();
  unknown.unmount();

  preferences.encryptedUrlPreviews = true;
  render(LinkPreviewCard, { url: 'https://example.org/f', encrypted: true });
  await tick();
  await Promise.resolve();
  await tick();

  expect(core.rpc.messages.urlPreview).toHaveBeenCalledWith({
    url: 'https://example.org/f',
    service: null,
  });
});

async function settle(): Promise<void> {
  await tick();
  await Promise.resolve();
  await tick();
  await Promise.resolve();
  await tick();
}

test('client-side embeds alone preview without asking the homeserver', async () => {
  preferences.clientEmbeds = true;
  core.rpc.messages.urlPreview.mockResolvedValue(preview({ url: 'https://example.org/c1' }));
  render(LinkPreviewCard, { url: 'https://example.org/c1', encrypted: false });
  await settle();

  expect(core.rpc.messages.urlPreview).toHaveBeenCalledTimes(1);
  expect(core.rpc.messages.urlPreview).toHaveBeenCalledWith({
    url: 'https://example.org/c1',
    client: true,
    service: 'https://embeds.test',
    klipy_api_key: null,
  });
  expect(screen.getByRole('link', { name: /Example/ })).toBeInTheDocument();
});

test('the homeserver is asked only when the client side has no answer', async () => {
  preferences.clientEmbeds = true;
  preferences.urlPreviews = true;
  core.rpc.messages.urlPreview.mockImplementation(({ client }) =>
    Promise.resolve(client ? null : preview({ url: 'https://example.org/c2' }))
  );
  render(LinkPreviewCard, { url: 'https://example.org/c2', encrypted: false });
  await settle();

  expect(core.rpc.messages.urlPreview.mock.calls).toEqual([
    [
      {
        url: 'https://example.org/c2',
        client: true,
        service: 'https://embeds.test',
        klipy_api_key: null,
      },
    ],
    [{ url: 'https://example.org/c2', service: null }],
  ]);
  expect(screen.getByRole('link', { name: /Example/ })).toBeInTheDocument();
});

test('a client-side answer is not followed by a homeserver request', async () => {
  preferences.clientEmbeds = true;
  preferences.urlPreviews = true;
  core.rpc.messages.urlPreview.mockResolvedValue(preview({ url: 'https://example.org/c3' }));
  render(LinkPreviewCard, { url: 'https://example.org/c3', encrypted: false });
  await settle();

  expect(core.rpc.messages.urlPreview).toHaveBeenCalledTimes(1);
});

test('an encrypted room needs its own consent for client-side embeds', async () => {
  preferences.clientEmbeds = true;
  core.rpc.messages.urlPreview.mockResolvedValue(preview());
  render(LinkPreviewCard, { url: 'https://example.org/c4', encrypted: true });
  await settle();

  expect(core.rpc.messages.urlPreview).not.toHaveBeenCalled();
});

test('an image-only preview renders inline instead of as a card', async () => {
  preferences.urlPreviews = true;
  core.rpc.messages.urlPreview.mockResolvedValue(
    preview({
      url: 'https://media.example/anim.gif',
      title: null,
      description: 'anim.gif',
      image: 'mxc://example.org/anim',
      image_mime: 'image/gif',
      image_width: 320,
      image_height: 240,
    })
  );
  render(LinkPreviewCard, {
    url: 'https://media.example/anim.gif',
    encrypted: false,
  });

  await tick();
  await Promise.resolve();
  await tick();

  const button = screen.getByRole('button', { name: 'Open anim.gif' });
  expect(button.parentElement?.parentElement).toHaveClass('link-preview-inline');
  expect(button.closest('.link-preview')).not.toBeInTheDocument();
});

test('an image-only preview stays mounted while its url is resolved again', async () => {
  preferences.urlPreviews = true;
  core.rpc.messages.urlPreview.mockResolvedValue(
    preview({
      url: 'https://media.example/anim.gif',
      title: null,
      description: 'anim.gif',
      image: 'mxc://example.org/anim',
      image_mime: 'image/gif',
    })
  );
  const { rerender } = render(LinkPreviewCard, {
    url: 'https://media.example/anim.gif',
    encrypted: false,
  });
  const shown = await screen.findByRole('button', { name: 'Open anim.gif' });

  await rerender({
    url: 'https://media.example/anim.gif',
    encrypted: false,
    bundled: preview({ url: 'https://media.example/anim.gif', title: null }),
  });

  await tick();
  expect(screen.getByRole('button', { name: 'Open anim.gif' })).toBe(shown);
});

test('an image-only preview unmounts cleanly when its preview is cleared', async () => {
  preferences.urlPreviews = true;
  core.rpc.messages.urlPreview.mockResolvedValue(
    preview({
      url: 'https://media.example/clear.gif',
      title: null,
      description: 'clear.gif',
      image: 'mxc://example.org/clear',
    })
  );
  render(LinkPreviewCardTooltipHarness, { url: 'https://media.example/clear.gif' });
  await screen.findByRole('button', { name: 'Open clear.gif' });

  preferences.urlPreviews = false;
  await tick();

  expect(screen.queryByRole('button', { name: 'Open clear.gif' })).not.toBeInTheDocument();
});

test('an image-only preview opens the media viewer instead of the url', async () => {
  preferences.urlPreviews = true;
  core.rpc.messages.urlPreview.mockResolvedValue(
    preview({
      url: 'https://media.example/anim.gif',
      title: null,
      description: 'anim.gif',
      image: 'mxc://example.org/anim',
      image_mime: 'image/gif',
      image_width: 320,
      image_height: 240,
    })
  );
  render(LinkPreviewCardMediaHarness, {
    url: 'https://media.example/anim.gif',
    joinRule: 'invite',
  });

  await tick();
  await Promise.resolve();
  await tick();

  expect(screen.queryByRole('link')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: /Open/ }));
  expect(mediaViewerState.eventId).toBe('standalone-1');
});

test('a preview carrying a title stays a card even with an image', async () => {
  preferences.urlPreviews = true;
  core.rpc.messages.urlPreview.mockResolvedValue(
    preview({
      url: 'https://example.org/post',
      image: 'mxc://example.org/hero',
    })
  );
  render(LinkPreviewCard, {
    url: 'https://example.org/post',
    encrypted: false,
  });

  await tick();
  await Promise.resolve();
  await tick();

  const link = screen.getByRole('link', { name: /Example/ });
  expect(link.parentElement).toHaveClass('link-preview');
  expect(link).not.toHaveClass('link-preview-link');
});

test('uses a site-specific presentation for a recognised URL', () => {
  preferences.urlPreviews = true;
  render(LinkPreviewCard, {
    url: 'https://youtu.be/MTn_bhTVr2U',
    encrypted: false,
    bundled: preview({
      url: 'https://youtu.be/MTn_bhTVr2U',
      title: 'A video',
      site_name: 'YouTube',
    }),
  });

  expect(screen.getByRole('link', { name: 'A video' }).parentElement).toHaveClass(
    'youtube-preview'
  );
});

test('a preview keeps its text but drops its picture where media previews are off (MSC4278)', async () => {
  preferences.urlPreviews = true;
  mediaPreviewSettings.global = { media_previews: 'off' };
  core.rpc.messages.urlPreview.mockResolvedValue(
    preview({
      url: 'https://example.org/pictured',
      image: 'mxc://example.org/thumb',
    })
  );
  render(LinkPreviewCardMediaHarness, {
    url: 'https://example.org/pictured',
    joinRule: 'invite',
  });

  await tick();
  await Promise.resolve();
  await tick();

  expect(screen.getByRole('link', { name: /Example/ }).parentElement).toHaveClass('link-preview');
  expect(document.querySelector('.link-preview-image')).toBeNull();
  mediaPreviewSettings.global = {};
});

test.each([
  ['https://example.org/ordinary', 'Example', null],
  ['https://example.org/image-only', null, null],
  ['https://youtu.be/MTn_bhTVr2U', 'A video', 'YouTube'],
])('the image at %s can be hidden without following its link', async (url, title, site_name) => {
  preferences.urlPreviews = true;
  const onDocumentClick = vi.fn();
  document.addEventListener('click', onDocumentClick);
  render(LinkPreviewCard, {
    url,
    encrypted: false,
    bundled: preview({
      url,
      title,
      site_name,
      image: 'mxc://example.org/preview-spoiler',
    }),
  });
  await tick();
  const hide = screen.getByRole('button', { name: 'Hide image' });
  expect(hide.closest('a')).toBeNull();
  await userEvent.click(hide);
  expect(document.querySelector('.spoilerable-media')).toHaveClass('spoilered');
  expect(onDocumentClick).not.toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: 'Reveal image' }));
  expect(document.querySelector('.spoilerable-media')).not.toHaveClass('spoilered');
  document.removeEventListener('click', onDocumentClick);
});

test('a video-only preview plays inline without the card', async () => {
  preferences.urlPreviews = true;
  core.rpc.messages.urlPreview.mockResolvedValue(
    preview({
      url: 'https://cdn.example/clip.mp4',
      title: null,
      video: {
        source: 'mxc://example.org/clip',
        mime: 'video/mp4',
        width: 1280,
        height: 720,
        gif: false,
      },
    })
  );
  const { container } = render(LinkPreviewCard, {
    url: 'https://cdn.example/clip.mp4',
    encrypted: false,
  });

  await tick();
  await Promise.resolve();
  await tick();

  expect(screen.getByRole('button', { name: /Play/ })).toBeInTheDocument();
  expect(container.querySelector('.link-preview')).toBeNull();
});

test('a GIF poster on a video preview stays still while GIF autoplay is off', async () => {
  preferences.urlPreviews = true;
  preferences.autoplayGifs = false;
  core.fetchMedia.mockResolvedValue(new Uint8Array([1]));
  core.rpc.messages.urlPreview.mockResolvedValue(
    preview({
      url: 'https://tenor.example/view/clip',
      image: 'mxc://example.org/poster',
      image_mime: 'image/gif',
      video: {
        source: 'mxc://example.org/clip',
        mime: 'video/mp4',
        width: 480,
        height: 362,
        gif: false,
      },
    })
  );
  const { container } = render(LinkPreviewCard, {
    url: 'https://tenor.example/view/clip',
    encrypted: false,
  });

  await vi.waitFor(() => {
    expect(container.querySelector('.media-poster .gif-preview-source')).not.toBeNull();
  });
});

test('a page with a video keeps its text under the player', async () => {
  preferences.urlPreviews = true;
  core.rpc.messages.urlPreview.mockResolvedValue(
    preview({
      url: 'https://site.example/watch',
      title: 'A clip',
      author_name: 'someone',
      video: {
        source: 'mxc://example.org/watch',
        mime: 'video/mp4',
        width: null,
        height: null,
        gif: false,
      },
    })
  );
  const { container } = render(LinkPreviewCard, {
    url: 'https://site.example/watch',
    encrypted: false,
  });

  await tick();
  await Promise.resolve();
  await tick();

  expect(screen.getByRole('button', { name: /Play/ })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: /A clip/ })).toBeInTheDocument();
  expect(container.querySelector('.link-preview-author')).toHaveTextContent('someone');
});

test('the theme colour becomes the card accent and a summary card is compact', async () => {
  preferences.urlPreviews = true;
  core.rpc.messages.urlPreview.mockResolvedValue(
    preview({
      url: 'https://site.example/post',
      image: 'mxc://example.org/pic',
      image_width: 1600,
      image_height: 900,
      theme_color: '#ff4500',
      card: 'summary',
    })
  );
  const { container } = render(LinkPreviewCard, {
    url: 'https://site.example/post',
    encrypted: false,
  });

  await tick();
  await Promise.resolve();
  await tick();

  const card = container.querySelector('.link-preview');
  expect(card).toHaveClass('accented', 'compact');
  expect((card as HTMLElement).style.getPropertyValue('--link-preview-accent')).toBe('#ff4500');
});

test('a GIF video preview loops muted without controls or a play button', async () => {
  preferences.urlPreviews = true;
  core.rpc.messages.urlPreview.mockResolvedValue(
    preview({
      url: 'https://giphy.example/gifs/cat',
      image: 'mxc://example.org/poster',
      image_mime: 'image/webp',
      video: {
        source: 'mxc://example.org/clip',
        mime: 'video/mp4',
        width: 480,
        height: 480,
        gif: true,
      },
    })
  );
  const { container } = render(LinkPreviewCard, {
    url: 'https://giphy.example/gifs/cat',
    encrypted: false,
  });

  await vi.waitFor(() => {
    expect(container.querySelector('video')).not.toBeNull();
  });
  const video = container.querySelector('video');
  expect(video).toHaveAttribute('loop');
  expect(video).not.toHaveAttribute('controls');
  expect(screen.queryByRole('button', { name: /Play/ })).toBeNull();
});
