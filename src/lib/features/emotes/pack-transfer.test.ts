import { unzipSync, zipSync } from 'fflate';
import { expect, test, vi } from 'vitest';

import type { ImagePackView } from '#src/generated/protocol';

import { MANIFEST_NAME } from './pack-archive';
import { packDraft } from './pack-content';
import { buildArchive, importArchive, type PackTransferCore } from './pack-transfer';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const GIF = new Uint8Array([0x47, 0x49, 0x46, 0x38, 0x39, 0x61, 9, 9]);

interface FakeCore extends PackTransferCore {
  uploads: { mime: string; bytes: Uint8Array }[];
}

function fakeCore(stored: Record<string, Uint8Array | undefined>): FakeCore {
  const uploads: { mime: string; bytes: Uint8Array }[] = [];
  return {
    uploads,
    commands: {
      fetchMedia: vi.fn((source: string) => {
        const bytes = stored[source];
        return bytes === undefined
          ? Promise.reject(new Error(`no media at ${source}`))
          : Promise.resolve(new Uint8Array(bytes));
      }),
      uploadMedia: vi.fn((mime: string, bytes: Uint8Array<ArrayBuffer>) => {
        uploads.push({ mime, bytes });
        return Promise.resolve(`mxc://new.example.org/${String(uploads.length)}`);
      }),
    },
  };
}

function pack(overrides: Partial<ImagePackView> = {}): ImagePackView {
  return {
    id: 'blobs',
    origin: 'room',
    room_id: '!r:example.org',
    name: 'Blobs',
    avatar_url: 'mxc://old/av',
    attribution: 'CC BY 4.0',
    usage: ['emoticon', 'sticker'],
    images: [
      {
        shortcode: 'blob_wave',
        url: 'mxc://old/wave',
        body: 'a waving blob',
        usage: ['emoticon'],
        info: { width: 128, height: 128, mimetype: 'image/png', size: PNG.length },
        source_pack: null,
      },
      {
        shortcode: 'blob_party',
        url: 'mxc://old/party',
        body: null,
        usage: ['emoticon', 'sticker'],
        info: null,
        source_pack: null,
      },
    ],
    ...overrides,
  };
}

const media = {
  'mxc://old/wave': PNG,
  'mxc://old/party': GIF,
  'mxc://old/av': PNG,
};

test('an exported pack carries the bytes, not just the mxc uris', async () => {
  const core = fakeCore(media);
  const files = unzipSync(await buildArchive(core, [packDraft(pack())]));

  expect(Object.keys(files).toSorted()).toEqual([
    'avatars/0.png',
    'images/0-blob_party.gif',
    'images/0-blob_wave.png',
    MANIFEST_NAME,
  ]);
  expect(files['images/0-blob_party.gif']).toEqual(GIF);
});

test('the export asks for the original, never a thumbnail', async () => {
  const core = fakeCore(media);
  await buildArchive(core, [packDraft(pack())]);

  for (const call of vi.mocked(core.commands.fetchMedia).mock.calls) {
    expect(call.slice(1)).toEqual([0, 0]);
  }
});

test('an image with no declared mimetype is named from its own bytes', async () => {
  const core = fakeCore(media);
  const files = unzipSync(await buildArchive(core, [packDraft(pack())]));

  expect(files).toHaveProperty(['images/0-blob_party.gif']);
});

test('a pack survives a round trip onto a homeserver that never saw the originals', async () => {
  const exporter = fakeCore(media);
  const archive = await buildArchive(exporter, [packDraft(pack())]);

  const importer = fakeCore({});
  const [imported] = await importArchive(importer, archive);

  expect(imported.name).toBe('Blobs');
  expect(imported.attribution).toBe('CC BY 4.0');
  expect(imported.avatarUrl).toMatch(/^mxc:\/\/new\.example\.org\//u);
  expect(imported.images.map((image) => image.shortcode).toSorted()).toEqual([
    'blob_party',
    'blob_wave',
  ]);

  const [wave] = imported.images.filter((image) => image.shortcode === 'blob_wave');
  expect(wave.url).toMatch(/^mxc:\/\/new\.example\.org\//u);
  expect(wave.body).toBe('a waving blob');
  expect(wave.usage).toEqual(['emoticon']);
  expect(wave.info).toEqual({ width: 128, height: 128, mimetype: 'image/png', size: PNG.length });

  const [uploadedWave] = importer.uploads.filter((upload) => upload.mime === 'image/png');
  expect(uploadedWave.bytes).toEqual(PNG);
  expect(importer.uploads.some((upload) => upload.mime === 'image/gif')).toBe(true);
});

test('an archive recompressed by another tool still imports', async () => {
  const archive = unzipSync(await buildArchive(fakeCore(media), [packDraft(pack())]));
  const [imported] = await importArchive(fakeCore({}), zipSync(archive, { level: 9 }));

  expect(imported.images).toHaveLength(2);
});

test('two packs export into one archive without colliding', async () => {
  const core = fakeCore(media);
  const second = pack({ id: 'more', name: 'More', images: pack().images.slice(0, 1) });
  const files = unzipSync(await buildArchive(core, [packDraft(pack()), packDraft(second)]));

  expect(files).toHaveProperty(['images/0-blob_wave.png']);
  expect(files).not.toHaveProperty(['images/1-blob_wave.png']);
  const [first, last] = await importArchive(
    fakeCore({}),
    await buildArchive(core, [packDraft(pack()), packDraft(second)])
  );
  expect(first.name).toBe('Blobs');
  expect(last.name).toBe('More');
  expect(last.images).toHaveLength(1);
});

test('a shared image is fetched and stored once', async () => {
  const core = fakeCore(media);
  const shared = pack({
    avatar_url: 'mxc://old/wave',
    images: pack().images.slice(0, 1),
  });
  const files = unzipSync(await buildArchive(core, [packDraft(shared)]));

  expect(vi.mocked(core.commands.fetchMedia).mock.calls).toHaveLength(1);
  expect(Object.keys(files).toSorted()).toEqual(['images/0-blob_wave.png', MANIFEST_NAME]);
});

test('an archive without a manifest is refused', async () => {
  const core = fakeCore(media);
  const stripped = await buildArchive(core, []);

  await expect(importArchive(core, stripped)).resolves.toEqual([]);
  await expect(importArchive(core, new TextEncoder().encode('nope'))).rejects.toThrow(
    /invalid zip data/u
  );
});
