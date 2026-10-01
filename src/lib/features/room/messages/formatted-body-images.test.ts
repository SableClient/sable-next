import { Window } from 'happy-dom';
import { expect, test, vi } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';

import { FormattedBodyImages } from './formatted-body-images';

vi.mock('#lib/ui/media-url.js', () => ({
  cachedMediaUrl: () => 'blob:fixture',
  holdMediaUrl: () => () => {},
  loadMediaUrl: vi.fn(),
  retryMediaUrl: vi.fn(),
}));

const images = new FormattedBodyImages(
  {} as CoreClient,
  () => '',
  () => {}
);

test.each([
  '<img src="mxc://example.org/image" alt="Photo">',
  "<img src='mxc://example.org/image' alt='Photo'>",
  '<img src=mxc://example.org/image alt=Photo>',
  '<IMG SRC = "mxc://example.org/image" alt="Photo">',
])('defers image requests before inserting HTML: %s', (html) => {
  const deferred = images.defer(html);
  expect(deferred).toMatch(/data-sable-src\s*=/i);
  expect(deferred).not.toMatch(/\s+src\s*=/i);
});

test('leaves source-like text and other attributes alone', () => {
  const html = '<p>src="mxc://example.org/image"</p><img data-src="backup" alt="Photo">';
  expect(images.defer(html)).toBe(html);
});

test.each(['https://tracker.example/pixel', 'http://tracker.example/pixel', 'mxc://example.org/'])(
  'rejects custom emote source %s',
  (source) => {
    const window = new Window();
    const node = window.document.createElement('div');
    const resolver = new FormattedBodyImages(
      {} as CoreClient,
      () => 'wave',
      () => {}
    );
    node.innerHTML = resolver.defer(`<img data-mx-emoticon src="${source}" alt="wave">`);
    resolver.attach(node as unknown as HTMLElement, false);
    expect(node.querySelector('img')).toBeNull();
    expect(node.textContent).toBe('wave');
  }
);
