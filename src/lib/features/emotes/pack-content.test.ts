import { expect, test } from 'vitest';

import type { ImagePackView } from '#src/generated/ImagePackView';

import {
  emptyDraft,
  normalizeShortcode,
  packDraft,
  packEventContent,
  shortcodeWithoutExtension,
  suffixRename,
  uniqueShortcode,
} from './pack-content';

function pack(overrides: Partial<ImagePackView> = {}): ImagePackView {
  return {
    id: 'blobs',
    origin: 'room',
    room_id: '!r:example.org',
    name: 'Blobs',
    avatar_url: 'mxc://a/av',
    attribution: 'CC BY 4.0',
    images: [
      {
        shortcode: 'wave',
        url: 'mxc://a/b',
        body: 'blob wave',
        usage: ['emoticon', 'sticker'],
        info: { width: 32, height: 32, mimetype: 'image/png', size: 128 },
      },
    ],
    ...overrides,
  };
}

test('the written content carries the dimensions on the wire keys', () => {
  const content = packEventContent(packDraft(pack()));
  const images = (content.images as Record<string, Record<string, unknown>>).wave;

  expect(images.info).toEqual({ w: 32, h: 32, mimetype: 'image/png', size: 128 });
});

test('an image with no declared info leaves the key off', () => {
  const draft = packDraft(
    pack({ images: [{ shortcode: 'wave', url: 'mxc://a/b', body: null, usage: [], info: null }] })
  );
  const images = (packEventContent(draft).images as Record<string, Record<string, unknown>>).wave;

  expect(images.info).toBeUndefined();
  expect(images.body).toBeUndefined();
});

test('a pack usable for both leaves the usage key off, so the default applies', () => {
  const content = packEventContent(packDraft(pack()));

  expect((content.pack as Record<string, unknown>).usage).toBeUndefined();
});

test('the meta round-trips', () => {
  const content = packEventContent(packDraft(pack())).pack as Record<string, unknown>;

  expect(content.display_name).toBe('Blobs');
  expect(content.avatar_url).toBe('mxc://a/av');
  expect(content.attribution).toBe('CC BY 4.0');
});

test('an empty draft writes no meta at all', () => {
  const content = packEventContent(emptyDraft()).pack as Record<string, unknown>;

  expect(content.display_name).toBeUndefined();
  expect(content.attribution).toBeUndefined();
});

test('a shortcode loses its delimiters and its spaces', () => {
  expect(normalizeShortcode(' :blob wave: ')).toBe('blob-wave');
  expect(normalizeShortcode('  ')).toBe('');
});

test('a taken shortcode is suffixed rather than overwriting', () => {
  const taken = new Set(['wave', 'wave-1']);

  expect(uniqueShortcode('party', (candidate) => taken.has(candidate))).toBe('party');
  expect(uniqueShortcode('wave', (candidate) => taken.has(candidate))).toBe('wave-2');
  expect(suffixRename('wave', (candidate) => taken.has(candidate))).toBe('wave-2');
});

test('a filename becomes a shortcode without its extension', () => {
  expect(shortcodeWithoutExtension('blob-wave.png')).toBe('blob-wave');
  expect(shortcodeWithoutExtension('noextension')).toBe('noextension');
});
