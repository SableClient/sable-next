// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';

import type { PostView, UrlPreviewView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');
vi.mock('#lib/config/runtime-config.js', () => ({
  runtimeConfig: () =>
    Promise.resolve({ embeds: { serviceUrl: null }, gifs: { klipyApiKey: null } }),
}));

import { core } from '#lib/core/__mocks__/context.js';

import PostLinkPreview from './PostLinkPreview.svelte';

function post(overrides: Partial<PostView> = {}): PostView {
  return {
    url: null,
    author: { name: 'Alice', handle: 'alice.test', avatar: null, url: null },
    text: 'hello',
    created_at: null,
    media: [],
    stats: null,
    sensitivity: null,
    sensitivity_reason: null,
    quote: null,
    ...overrides,
  };
}

function preview(value: PostView): UrlPreviewView {
  return {
    url: 'https://bsky.app/profile/alice.test/post/3abc',
    title: 'Alice (@alice.test)',
    description: 'hello',
    site_name: 'Bluesky',
    image: null,
    image_mime: null,
    image_width: null,
    image_height: null,
    video: null,
    theme_color: null,
    card: null,
    author_name: null,
    post: value,
  };
}

function renderPost(value: PostView, mediaHidden = false) {
  const shown = preview(value);
  return render(PostLinkPreview, { url: shown.url, preview: shown, mediaHidden });
}

test('shows the author, text, quote and the counts it knows', () => {
  renderPost(
    post({
      stats: { replies: 3, reposts: null, likes: 1 },
      quote: post({
        author: { name: null, handle: 'bob.test', avatar: null, url: null },
        text: 'quoted',
      }),
    })
  );

  expect(screen.getByRole('link')).toHaveAttribute(
    'href',
    'https://bsky.app/profile/alice.test/post/3abc'
  );
  expect(screen.getByText('Bluesky')).toBeInTheDocument();
  expect(screen.getByText('Alice')).toBeInTheDocument();
  expect(screen.getByText('@alice.test')).toBeInTheDocument();
  expect(screen.getByText('hello')).toBeInTheDocument();
  expect(screen.getByText('@bob.test')).toBeInTheDocument();
  expect(screen.getByText('quoted')).toBeInTheDocument();
  expect(screen.getByTitle('3 replies')).toHaveTextContent('3');
  expect(screen.getByTitle('1 like')).toHaveTextContent('1');
  expect(screen.queryByTitle(/repost/)).not.toBeInTheDocument();
});

test('shows when the post was made', () => {
  const { container } = renderPost(post({ created_at: 1_791_763_200_000 }));

  expect(container.querySelector('time')).toHaveAttribute('datetime', '2026-10-12T00:00:00.000Z');
});

test('hides avatars and media while room media is hidden', () => {
  const { container } = renderPost(
    post({
      author: { name: 'Alice', handle: null, avatar: 'mxc://s/face', url: null },
      media: [
        {
          kind: 'image',
          source: 'mxc://s/cat',
          poster: null,
          mime: null,
          width: null,
          height: null,
          alt: 'a cat',
        },
      ],
    }),
    true
  );

  expect(container.querySelector('.post-media')).not.toBeInTheDocument();
  expect(container.querySelector('img')).not.toBeInTheDocument();
  expect(screen.getByText('hello')).toBeInTheDocument();
});

test('hides the text of a sensitive post until revealed, and names the warning', async () => {
  renderPost(
    post({
      sensitivity: 'spoiler',
      sensitivity_reason: 'Star Wars',
      quote: post({
        author: { name: null, handle: 'bob.test', avatar: null, url: null },
        text: 'quoted',
        sensitivity: 'graphic',
      }),
    })
  );

  expect(screen.getByText('Alice')).toBeInTheDocument();
  expect(screen.queryByText('hello')).not.toBeInTheDocument();
  expect(screen.queryByText('quoted')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: /Graphic content/ })).toBeInTheDocument();

  await fireEvent.click(screen.getByRole('button', { name: /Star Wars/ }));

  expect(screen.getByText('hello')).toBeInTheDocument();
  expect(screen.queryByText('quoted')).not.toBeInTheDocument();
});

test('plays a bundled video by scraping the link again', async () => {
  const video = {
    kind: 'video' as const,
    mime: 'video/mp4',
    width: 16,
    height: 9,
    alt: null,
  };
  const scraped = preview(
    post({ media: [{ ...video, source: 'https://pds/clip', poster: null }] })
  );
  core.rpc.messages.urlPreview.mockResolvedValue(scraped);
  core.fetchMedia.mockResolvedValue(new Uint8Array([1]));
  const { container } = renderPost(
    post({ media: [{ ...video, source: null, poster: 'mxc://s/still' }] })
  );

  expect(container.querySelector('.media-poster')).toBeInTheDocument();
  expect(core.rpc.messages.urlPreview).not.toHaveBeenCalled();

  await fireEvent.click(screen.getByRole('button', { name: /Play/ }));

  await vi.waitFor(() => {
    expect(container.querySelector('video')).toBeInTheDocument();
  });
  expect(core.rpc.messages.urlPreview).toHaveBeenCalledWith(
    expect.objectContaining({ url: scraped.url, client: true })
  );
  expect(core.fetchMedia).toHaveBeenCalledWith('https://pds/clip', 0, 0);
});
