// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { UrlPreviewView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

import { core as baseCore } from '#lib/core/__mocks__/context.js';

const core = Object.assign(baseCore, {
  urlPreview: vi.fn<() => Promise<UrlPreviewView | null>>(),
});

import LinkPreviewCard from './LinkPreviewCard.svelte';
import LinkPreviewCardMediaHarness from './LinkPreviewCardMediaHarness.test.svelte';
import type { StandaloneMedia } from './media-viewer-opener.svelte.js';
import { mediaPreviewSettings } from '#lib/settings/media-previews.svelte.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

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
    ...overrides,
  };
}

afterEach(() => {
  core.urlPreview.mockReset();
  preferences.urlPreviews = false;
  preferences.encryptedUrlPreviews = false;
  vi.restoreAllMocks();
});

test('renders the resolved preview as a link', async () => {
  preferences.urlPreviews = true;
  core.urlPreview.mockResolvedValue(preview({ url: 'https://example.org/render' }));
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
  core.urlPreview.mockResolvedValue(preview({ url: 'https://example.org/cached' }));
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

  expect(core.urlPreview).toHaveBeenCalledTimes(1);
});

test('an in-flight request does not write into a torn-down component', async () => {
  preferences.urlPreviews = true;
  let resolve: (value: UrlPreviewView | null) => void = () => {};
  core.urlPreview.mockReturnValue(
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

test('does nothing while url previews are disabled', async () => {
  preferences.urlPreviews = false;
  core.urlPreview.mockResolvedValue(preview());
  render(LinkPreviewCard, { url: 'https://example.org/c', encrypted: false });

  await tick();
  await Promise.resolve();
  await tick();

  expect(core.urlPreview).not.toHaveBeenCalled();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
});

test('an encrypted room needs its own consent, and an unknown one is treated as encrypted', async () => {
  preferences.urlPreviews = true;
  core.urlPreview.mockResolvedValue(preview());
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

  expect(core.urlPreview).not.toHaveBeenCalled();
  encrypted.unmount();
  unknown.unmount();

  preferences.encryptedUrlPreviews = true;
  render(LinkPreviewCard, { url: 'https://example.org/f', encrypted: true });
  await tick();
  await Promise.resolve();
  await tick();

  expect(core.urlPreview).toHaveBeenCalledWith('https://example.org/f');
});

test('an image-only preview renders inline instead of as a card', async () => {
  preferences.urlPreviews = true;
  core.urlPreview.mockResolvedValue(
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

  const link = screen.getByRole('link');
  expect(link).not.toHaveClass('link-preview');
  expect(link).toHaveAttribute('href', 'https://media.example/anim.gif');
  expect(link.closest('.link-preview-inline')).toBeInTheDocument();
});

test('an image-only preview opens the media viewer instead of the url', async () => {
  preferences.urlPreviews = true;
  core.urlPreview.mockResolvedValue(
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
  const opener = vi.fn<(item: StandaloneMedia) => void>();
  render(LinkPreviewCardMediaHarness, {
    url: 'https://media.example/anim.gif',
    joinRule: 'invite',
    opener,
  });

  await tick();
  await Promise.resolve();
  await tick();

  expect(screen.queryByRole('link')).toBeNull();
  await userEvent.click(screen.getByRole('button', { name: /Open/ }));
  expect(opener).toHaveBeenCalledWith({
    kind: 'image',
    filename: 'https://media.example/anim.gif',
    caption: null,
    html: null,
    source: 'mxc://example.org/anim',
    mime: 'image/gif',
    width: 320,
    height: 240,
    size: null,
    blurhash: null,
    thumbnail: null,
    spoiler: null,
    animated: null,
    sender: 'https://media.example/anim.gif',
  });
});

test('a preview carrying a title stays a card even with an image', async () => {
  preferences.urlPreviews = true;
  core.urlPreview.mockResolvedValue(
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
  core.urlPreview.mockResolvedValue(
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
  core.urlPreview.mockResolvedValue(
    preview({
      url: 'https://cdn.example/clip.mp4',
      title: null,
      video: {
        source: 'mxc://example.org/clip',
        mime: 'video/mp4',
        width: 1280,
        height: 720,
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

test('a page with a video keeps its text under the player', async () => {
  preferences.urlPreviews = true;
  core.urlPreview.mockResolvedValue(
    preview({
      url: 'https://site.example/watch',
      title: 'A clip',
      author_name: 'someone',
      video: {
        source: 'mxc://example.org/clip',
        mime: 'video/mp4',
        width: null,
        height: null,
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
  core.urlPreview.mockResolvedValue(
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
  expect(card).toHaveStyle({ '--link-preview-accent': '#ff4500' });
});
