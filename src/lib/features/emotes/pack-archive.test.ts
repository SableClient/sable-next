import { expect, test } from 'vitest';

import {
  archiveImages,
  archivePack,
  avatarEntryName,
  entryName,
  manifestJson,
  parseManifest,
} from './pack-archive';
import { emptyDraft, type PackDraft } from './pack-content';

function draft(overrides: Partial<PackDraft> = {}): PackDraft {
  return {
    ...emptyDraft(),
    name: 'Blobs',
    avatarUrl: 'mxc://a/av',
    attribution: 'CC BY 4.0',
    images: [
      {
        shortcode: 'blob_wave',
        url: 'mxc://a/b',
        body: 'a waving blob',
        usage: ['emoticon'],
        info: { width: 128, height: 128, mimetype: 'image/png', size: 4096 },
      },
    ],
    ...overrides,
  };
}

const files = new Map([
  ['mxc://a/b', 'images/0-blob_wave.png'],
  ['mxc://a/av', 'avatars/0.png'],
]);

test('an entry name carries the extension the pack declares', () => {
  expect(entryName(2, 'blob_wave', 'image/gif')).toBe('images/2-blob_wave.gif');
  expect(avatarEntryName(2, 'image/webp')).toBe('avatars/2.webp');
});

test('an avatar never collides with an image called pack', () => {
  expect(avatarEntryName(0, 'image/png')).not.toBe(entryName(0, 'pack', 'image/png'));
});

test('an unknown mime still gets a name rather than dropping the image', () => {
  expect(entryName(0, 'wave', null)).toBe('images/0-wave.bin');
});

test('a pack round-trips through the manifest', () => {
  const written = archivePack(draft(), (url) => files.get(url));
  const [read] = parseManifest(manifestJson([written]));

  expect(read.pack.display_name).toBe('Blobs');
  expect(read.pack.avatar_file).toBe('avatars/0.png');
  expect(read.pack.attribution).toBe('CC BY 4.0');
  expect(read.images.blob_wave).toEqual({
    file: 'images/0-blob_wave.png',
    body: 'a waving blob',
    usage: ['emoticon'],
    info: { w: 128, h: 128, mimetype: 'image/png', size: 4096 },
  });
});

test('a pack usable for both leaves usage off, so the MSC default applies', () => {
  const written = archivePack(draft({ images: [] }), (url) => files.get(url));

  expect(written.pack.usage).toBeUndefined();
});

test('an image whose bytes never arrived is left out rather than dangling', () => {
  const written = archivePack(draft(), () => undefined);

  expect(written.images).toEqual({});
  expect(written.pack.avatar_file).toBeUndefined();
});

test('a shortcode outside the MSC grammar is repaired, not imported as is', () => {
  const [read] = parseManifest(
    JSON.stringify({
      version: 1,
      packs: [{ images: { 'blob wave!': { file: 'images/0-a.png' } } }],
    })
  );

  expect(Object.keys(read.images)).toEqual(['blob-wave']);
});

test('an image with no usable shortcode or file is dropped', () => {
  const [read] = parseManifest(
    JSON.stringify({
      version: 1,
      packs: [{ images: { '!!!': { file: 'a.png' }, ok: {}, fine: { file: 'b.png' } } }],
    })
  );

  expect(Object.keys(read.images)).toEqual(['fine']);
});

test('a future archive version is refused rather than half-read', () => {
  expect(() => parseManifest(JSON.stringify({ version: 2, packs: [] }))).toThrow(/version/u);
  expect(() => parseManifest('[]')).toThrow(/not an object/u);
});

test('an unknown usage falls back to both, matching the core reader', () => {
  const [read] = parseManifest(
    JSON.stringify({
      version: 1,
      packs: [{ images: { wave: { file: 'a.png', usage: ['reaction'] } } }],
    })
  );
  const [image] = archiveImages(read, () => 'mxc://new/1');

  expect(image.usage).toEqual(['emoticon', 'sticker']);
});

test('an image inherits the pack usage when it declares none', () => {
  const [read] = parseManifest(
    JSON.stringify({
      version: 1,
      packs: [{ pack: { usage: ['sticker'] }, images: { wave: { file: 'a.png' } } }],
    })
  );
  const [image] = archiveImages(read, () => 'mxc://new/1');

  expect(image.usage).toEqual(['sticker']);
});

test('an image whose file never uploaded is left out rather than pointing nowhere', () => {
  const written = archivePack(draft(), (url) => files.get(url));

  expect(archiveImages(written, () => undefined)).toEqual([]);
});
