import { expect, test } from 'vitest';

import type { ImagePackView } from '#src/generated/protocol';

import {
  emptyDraft,
  normalizeShortcode,
  packDraft,
  packEventContent,
  setImageUsage,
  shortcodeWithoutExtension,
  suffixRename,
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

test('the written content carries the dimensions on the wire keys', () => {
  const content = packEventContent(packDraft(pack()));
  const images = (content.images as Record<string, Record<string, unknown>>).wave;

  expect(images.info).toEqual({ w: 32, h: 32, mimetype: 'image/png', size: 128 });
});

test('an image with no declared info leaves the key off', () => {
  const draft = packDraft(
    pack({
      images: [
        {
          shortcode: 'wave',
          url: 'mxc://a/b',
          body: null,
          usage: [],
          info: null,
          source_pack: null,
        },
      ],
    })
  );
  const images = (packEventContent(draft).images as Record<string, Record<string, unknown>>).wave;

  expect(images.info).toBeUndefined();
  expect(images.body).toBeUndefined();
});

test('a pack usable for both leaves the usage key off, so the default applies', () => {
  const content = packEventContent(packDraft(pack()));

  expect((content.pack as Record<string, unknown>).usage).toBeUndefined();
});

test('a sticker-only pack keeps its usage through the editor', () => {
  const content = packEventContent(packDraft(pack({ usage: ['sticker'] })));

  expect((content.pack as Record<string, unknown>).usage).toEqual(['sticker']);
});

test('an image usage matching the pack is left to the pack', () => {
  const draft = packDraft(pack());
  const images = (
    packEventContent({ ...draft, usage: ['sticker'] }).images as Record<
      string,
      Record<string, unknown>
    >
  ).wave;

  expect(images.usage).toEqual(['emoticon', 'sticker']);
});

test('an image following a sticker-only pack inherits the pack usage', () => {
  const draft = packDraft(
    pack({
      usage: ['sticker'],
      images: [
        {
          shortcode: 'wave',
          url: 'mxc://a/b',
          body: null,
          usage: ['sticker'],
          info: null,
          source_pack: null,
        },
      ],
    })
  );

  expect((packEventContent(draft).pack as Record<string, unknown>).usage).toEqual(['sticker']);
  expect(
    (packEventContent(draft).images as Record<string, Record<string, unknown>>).wave.usage
  ).toBeUndefined();
});

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

test('duplicate names reserve room for the suffix', () => {
  const name = 'a'.repeat(100);
  const renamed = suffixRename(name, (candidate) => candidate.endsWith('-1'));
  expect(renamed).toBe(`${'a'.repeat(98)}-2`);
  expect(renamed).toHaveLength(100);
});

test('uploads whose names contain no shortcode characters get a valid name', () => {
  expect(uniqueShortcode('☃️', () => false)).toBe('image');
  expect(uniqueShortcode('', (candidate) => candidate === 'image')).toBe('image-1');
});

test.each(['', 'a'.repeat(101), 'a/b', 'snow☃'])(
  'refuses an invalid shortcode %s before writing',
  (shortcode) => {
    const draft = packDraft(pack());
    draft.images[0].shortcode = shortcode;
    expect(() => packEventContent(draft)).toThrow('Invalid or duplicate shortcode');
  }
);

test('refuses duplicate shortcodes before one image can overwrite another', () => {
  const draft = packDraft(pack());
  draft.images.push({ ...draft.images[0], url: 'mxc://a/c' });
  expect(() => packEventContent(draft)).toThrow('Invalid or duplicate shortcode');
});

test('an image can be limited to one usage and is then written with its own usage key', () => {
  const draft = setImageUsage(packDraft(pack()), 'wave', ['sticker']);

  expect(draft.images[0].usage).toEqual(['sticker']);
  const content = packEventContent(draft) as { images: { wave: { usage?: string[] } } };
  expect(content.images.wave.usage).toEqual(['sticker']);
});

test('an image set back to the pack usage drops its own usage key', () => {
  const limited = setImageUsage(packDraft(pack()), 'wave', ['emoticon']);
  const draft = setImageUsage(limited, 'wave', ['emoticon', 'sticker']);

  const content = packEventContent(draft) as { images: { wave: { usage?: string[] } } };
  expect(content.images.wave.usage).toBeUndefined();
});
