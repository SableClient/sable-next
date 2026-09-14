import type { CoreCommands } from '#lib/core/commands.svelte.js';
import { saveBytes, mimeFromName, type SaveOutcome } from '#lib/platform/files.js';
import { imageMime } from '#lib/ui/media-url.js';

import {
  archiveImages,
  archivePack,
  avatarEntryName,
  entryName,
  manifestJson,
  parseManifest,
  MANIFEST_NAME,
  type ArchivePack,
} from './pack-archive.js';
import { ALL_USAGES, type PackDraft } from './pack-content.js';
import { readZip, writeZip, type ZipEntry } from './zip.js';

export type PackTransferCore = {
  commands: Pick<CoreCommands, 'fetchMedia' | 'uploadMedia'>;
};

const MAX_TRANSFERS = 4;

async function inBatches<T>(tasks: (() => Promise<T>)[]): Promise<T[]> {
  const results: T[] = [];
  for (let start = 0; start < tasks.length; start += MAX_TRANSFERS) {
    const batch = tasks.slice(start, start + MAX_TRANSFERS);
    results.push(...(await Promise.all(batch.map((task) => task()))));
  }
  return results;
}

async function collect(
  core: PackTransferCore,
  drafts: PackDraft[]
): Promise<Map<string, ZipEntry>> {
  const wanted = new Map<string, (mime: string | null) => string>();
  for (const [index, draft] of drafts.entries()) {
    for (const image of draft.images) {
      if (!wanted.has(image.url)) {
        wanted.set(image.url, (mime) => entryName(index, image.shortcode, mime));
      }
    }
    if (draft.avatarUrl !== null && !wanted.has(draft.avatarUrl)) {
      wanted.set(draft.avatarUrl, (mime) => avatarEntryName(index, mime));
    }
  }

  const fetched = await inBatches(
    [...wanted].map(([url, nameFor]) => async () => {
      const bytes = await core.commands.fetchMedia(url, 0, 0);
      return [url, { name: nameFor(imageMime(bytes) ?? null), bytes }] as const;
    })
  );

  return new Map(fetched);
}

function archiveName(drafts: PackDraft[]): string {
  const [first] = drafts;
  const named = drafts.length === 1 ? first.name : '';
  const slug = named.replaceAll(/[^a-zA-Z0-9_-]+/gu, '-').replaceAll(/^-+|-+$/gu, '');
  return `sable-emotes-${slug === '' ? String(Date.now()) : slug}.zip`;
}

export async function buildArchive(
  core: PackTransferCore,
  drafts: PackDraft[]
): Promise<Uint8Array<ArrayBuffer>> {
  const files = await collect(core, drafts);
  const manifest = drafts.map((draft) => archivePack(draft, (url) => files.get(url)?.name));
  const entries = new Map<string, ZipEntry>([
    [
      MANIFEST_NAME,
      { name: MANIFEST_NAME, bytes: new TextEncoder().encode(manifestJson(manifest)) },
    ],
  ]);
  for (const file of files.values()) {
    entries.set(file.name, file);
  }

  return writeZip([...entries.values()]);
}

export async function exportPacks(
  core: PackTransferCore,
  drafts: PackDraft[]
): Promise<SaveOutcome> {
  const bytes = await buildArchive(core, drafts);
  return saveBytes(bytes, archiveName(drafts), 'application/zip');
}

function declaredMimes(packs: ArchivePack[]): Map<string, string> {
  const mimes = new Map<string, string>();
  for (const pack of packs) {
    for (const image of Object.values(pack.images)) {
      if (image.info?.mimetype !== undefined) mimes.set(image.file, image.info.mimetype);
    }
  }
  return mimes;
}

export async function importArchive(
  core: PackTransferCore,
  bytes: Uint8Array
): Promise<PackDraft[]> {
  const files = readZip(bytes);
  const manifest = files.get(MANIFEST_NAME);
  if (manifest === undefined) throw new Error('The archive has no pack.json');

  const packs = parseManifest(new TextDecoder().decode(manifest));
  const declared = declaredMimes(packs);
  const referenced = new Set(
    packs.flatMap((pack) => [
      ...Object.values(pack.images).map((image) => image.file),
      ...(pack.pack.avatar_file === undefined ? [] : [pack.pack.avatar_file]),
    ])
  );

  const uploaded = new Map(
    await inBatches(
      [...files]
        .filter(([file]) => referenced.has(file))
        .map(([file, data]) => async () => {
          const mime = declared.get(file) ?? imageMime(data) ?? mimeFromName(file);
          return [file, await core.commands.uploadMedia(mime, data.slice())] as const;
        })
    )
  );

  return packs.map((pack) => ({
    name: pack.pack.display_name ?? '',
    avatarUrl:
      pack.pack.avatar_file === undefined ? null : (uploaded.get(pack.pack.avatar_file) ?? null),
    attribution: pack.pack.attribution ?? '',
    usage: pack.pack.usage ?? ALL_USAGES,
    images: archiveImages(pack, (file) => uploaded.get(file)),
  }));
}
