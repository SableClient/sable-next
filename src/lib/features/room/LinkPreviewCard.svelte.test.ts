// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { UrlPreviewView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');

import { core as baseCore } from '#lib/core/__mocks__/context.js';

const core = Object.assign(baseCore, { urlPreview: vi.fn<() => Promise<UrlPreviewView | null>>() });

import LinkPreviewCard from './LinkPreviewCard.svelte';
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
  render(LinkPreviewCard, { url: 'https://example.org/render', encrypted: false });

  await tick();
  await Promise.resolve();
  await tick();

  const link = screen.getByRole('link', { name: /Example/ });
  expect(link).toHaveAttribute('href', 'https://example.org/render');
  expect(link).toHaveClass('link-preview');
});

test('a second card for the same url does not re-request it', async () => {
  preferences.urlPreviews = true;
  core.urlPreview.mockResolvedValue(preview({ url: 'https://example.org/cached' }));
  const first = render(LinkPreviewCard, { url: 'https://example.org/cached', encrypted: false });
  await tick();
  await Promise.resolve();
  await tick();
  first.unmount();

  render(LinkPreviewCard, { url: 'https://example.org/cached', encrypted: false });
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
  const instance = render(LinkPreviewCard, { url: 'https://example.org/b', encrypted: false });
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
  const encrypted = render(LinkPreviewCard, { url: 'https://example.org/d', encrypted: true });
  const unknown = render(LinkPreviewCard, { url: 'https://example.org/e', encrypted: null });

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
  render(LinkPreviewCard, { url: 'https://media.example/anim.gif', encrypted: false });

  await tick();
  await Promise.resolve();
  await tick();

  const link = screen.getByRole('link');
  expect(link).not.toHaveClass('link-preview');
  expect(link).toHaveAttribute('href', 'https://media.example/anim.gif');
  expect(link.querySelector('.link-preview-inline')).toBeInTheDocument();
});

test('a preview carrying a title stays a card even with an image', async () => {
  preferences.urlPreviews = true;
  core.urlPreview.mockResolvedValue(
    preview({ url: 'https://example.org/post', image: 'mxc://example.org/hero' })
  );
  render(LinkPreviewCard, { url: 'https://example.org/post', encrypted: false });

  await tick();
  await Promise.resolve();
  await tick();

  const link = screen.getByRole('link', { name: /Example/ });
  expect(link).toHaveClass('link-preview');
  expect(link).not.toHaveClass('link-preview-link');
});
