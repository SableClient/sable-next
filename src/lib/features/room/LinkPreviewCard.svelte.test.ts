// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import type { UrlPreviewView } from '#src/generated/UrlPreviewView';

const core = vi.hoisted(() => {
  const urlPreview = vi.fn<() => Promise<UrlPreviewView | null>>();

  return { urlPreview, commands: { urlPreview } };
});

vi.mock('#lib/core/context.js', () => ({
  useCoreClient: () => core,
}));

import LinkPreviewCard from './LinkPreviewCard.svelte';
import { preferences } from '#lib/settings/preferences.svelte.js';

function preview(overrides: Partial<UrlPreviewView> = {}): UrlPreviewView {
  return {
    url: 'https://example.org/a',
    title: 'Example',
    description: null,
    site_name: null,
    image: null,
    image_width: null,
    image_height: null,
    ...overrides,
  };
}

afterEach(() => {
  core.urlPreview.mockReset();
  preferences.urlPreviews = false;
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

test('renders the resolved preview as a link', async () => {
  preferences.urlPreviews = true;
  core.urlPreview.mockResolvedValue(preview({ url: 'https://example.org/render' }));
  const instance = mount(LinkPreviewCard, {
    target: document.body,
    props: { url: 'https://example.org/render' },
  });

  await tick();
  await Promise.resolve();
  await tick();

  const link = document.body.querySelector('a.link-preview');
  expect(link?.getAttribute('href')).toBe('https://example.org/render');
  expect(link?.textContent).toContain('Example');
  await unmount(instance);
});

test('a second card for the same url does not re-request it', async () => {
  preferences.urlPreviews = true;
  core.urlPreview.mockResolvedValue(preview({ url: 'https://example.org/cached' }));
  const first = mount(LinkPreviewCard, {
    target: document.body,
    props: { url: 'https://example.org/cached' },
  });
  await tick();
  await Promise.resolve();
  await tick();
  await unmount(first);

  const second = mount(LinkPreviewCard, {
    target: document.body,
    props: { url: 'https://example.org/cached' },
  });
  await tick();
  await Promise.resolve();
  await tick();

  expect(core.urlPreview).toHaveBeenCalledTimes(1);
  await unmount(second);
});

test('an in-flight request does not write into a torn-down component', async () => {
  preferences.urlPreviews = true;
  let resolve: (value: UrlPreviewView | null) => void = () => {};
  core.urlPreview.mockReturnValue(
    new Promise((res) => {
      resolve = res;
    })
  );
  const instance = mount(LinkPreviewCard, {
    target: document.body,
    props: { url: 'https://example.org/b' },
  });
  await tick();

  await unmount(instance);
  expect(() => {
    resolve(preview({ url: 'https://example.org/b' }));
  }).not.toThrow();
  await tick();
});

test('does nothing while url previews are disabled', async () => {
  preferences.urlPreviews = false;
  core.urlPreview.mockResolvedValue(preview());
  const instance = mount(LinkPreviewCard, {
    target: document.body,
    props: { url: 'https://example.org/c' },
  });

  await tick();
  await Promise.resolve();
  await tick();

  expect(core.urlPreview).not.toHaveBeenCalled();
  expect(document.body.querySelector('a.link-preview')).toBeNull();
  await unmount(instance);
});
