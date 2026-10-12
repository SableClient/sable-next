import { expect, test } from 'vitest';

import type { ImagePackView } from '#src/generated/protocol';

import {
  invalidShortcode,
  normalizeShortcode,
  packDraft,
  setImageUsage,
  shortcodeWithoutExtension,
  togglePackUsage,
  uniqueShortcode,
} from './pack-content';

function pack(overrides: Partial<ImagePackView> = {}): ImagePackView {
  return {
    id: 'blobs',
    origin: 'room',
    room_id: '!r:example.org',
    name: 'Blobs',
    avatar_url: 'mxc://a/av',
    declared_name: 'Blobs',
    declared_avatar_url: 'mxc://a/av',
    stable_event: true,
    legacy_event: false,
    attribution: 'CC BY 4.0',
    usage: ['emoticon', 'sticker'],
    images: [
      {
        shortcode: 'wave',
        url: 'mxc://a/b',
        body: 'blob wave',
        usage: ['emoticon', 'sticker'],
        info: { width: 32, height: 32, mimetype: 'image/png', size: 128 },
        source_pack: null,
      },
    ],
    ...overrides,
  };
}

test('a toggle moves the images that follow the pack usage and keeps the exceptions', () => {
  const draft = packDraft(
    pack({
      usage: ['emoticon', 'sticker'],
      images: [
        {
          shortcode: 'wave',
          url: 'mxc://a/b',
          body: null,
          usage: ['emoticon', 'sticker'],
          info: null,
          source_pack: null,
        },
        {
          shortcode: 'party',
          url: 'mxc://a/c',
          body: null,
          usage: ['emoticon'],
          info: null,
          source_pack: null,
        },
      ],
    })
  );

  const next = togglePackUsage(draft, 'emoticon', false);

  expect(next?.usage).toEqual(['sticker']);
  expect(next?.images.map((image) => [image.shortcode, image.usage])).toEqual([
    ['wave', ['sticker']],
    ['party', ['emoticon']],
  ]);
});

test('a toggle that would leave no usage is refused', () => {
  const draft = packDraft(pack({ usage: ['sticker'] }));

  expect(togglePackUsage(draft, 'sticker', false)).toBeNull();
});

test('a shortcode loses its delimiters and its spaces', () => {
  expect(normalizeShortcode(' :blob wave: ')).toBe('blob-wave');
  expect(normalizeShortcode('  ')).toBe('');
});

test('a taken shortcode is suffixed rather than overwriting', () => {
  const taken = new Set(['wave', 'wave-1']);

  expect(uniqueShortcode('party', taken)).toBe('party');
  expect(uniqueShortcode('wave', taken)).toBe('wave-2');
});

test('a filename becomes a shortcode without its extension', () => {
  expect(shortcodeWithoutExtension('blob-wave.png')).toBe('blob-wave');
  expect(shortcodeWithoutExtension('noextension')).toBe('noextension');
});

test('duplicate names reserve room for the suffix', () => {
  const name = 'a'.repeat(100);
  const renamed = uniqueShortcode(name, [name, `${'a'.repeat(98)}-1`]);
  expect(renamed).toBe(`${'a'.repeat(98)}-2`);
  expect(renamed).toHaveLength(100);
});

test('uploads whose names contain no shortcode characters get a valid name', () => {
  expect(uniqueShortcode('☃️', [])).toBe('image');
  expect(uniqueShortcode('', ['image'])).toBe('image-1');
});

test.each(['', 'a'.repeat(101), 'a/b', 'snow☃'])('flags an invalid shortcode %s', (shortcode) => {
  const draft = packDraft(pack());
  draft.images[0].shortcode = shortcode;
  expect(invalidShortcode(draft.images)).toBe(shortcode);
});

test('an image can be limited to one usage', () => {
  const draft = setImageUsage(packDraft(pack()), 'wave', ['sticker']);

  expect(draft.images[0].usage).toEqual(['sticker']);
});

test('an image set back to the pack usage follows the pack again', () => {
  const limited = setImageUsage(packDraft(pack()), 'wave', ['emoticon']);
  const draft = setImageUsage(limited, 'wave', ['emoticon', 'sticker']);

  expect(draft.images[0].usage).toEqual(draft.usage);
});
