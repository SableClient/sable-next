import { expect, test } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';

import { FormattedBodyImages } from './formatted-body-images';

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
