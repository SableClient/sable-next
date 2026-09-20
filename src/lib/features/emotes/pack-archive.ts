import type { ImageUsageView } from '#src/generated/protocol';

import {
  ALL_USAGES,
  imageUsageContent,
  infoContent,
  MAX_SHORTCODE_LENGTH,
  normalizeShortcode,
  usageContent,
  type PackDraft,
  type PackImageDraft,
  type PackImageInfoContent,
} from './pack-content.js';

export const MANIFEST_NAME = 'pack.json';
export const ARCHIVE_VERSION = 1;

const IMAGE_DIRECTORY = 'images';
const AVATAR_DIRECTORY = 'avatars';
const EXTENSION_BY_MIME: Record<string, string> = {
  'image/apng': 'apng',
  'image/avif': 'avif',
  'image/gif': 'gif',
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/svg+xml': 'svg',
  'image/webp': 'webp',
};

export interface ArchiveImage {
  file: string;
  body?: string;
  usage?: ImageUsageView[];
  info?: PackImageInfoContent;
}

export interface ArchivePack {
  pack: {
    display_name?: string;
    avatar_file?: string;
    attribution?: string;
    usage?: ImageUsageView[];
  };
  images: Record<string, ArchiveImage>;
}

export function extensionFor(mime: string | null): string {
  return EXTENSION_BY_MIME[(mime ?? '').toLowerCase()] ?? 'bin';
}

export function entryName(packIndex: number, shortcode: string, mime: string | null): string {
  return `${IMAGE_DIRECTORY}/${String(packIndex)}-${shortcode}.${extensionFor(mime)}`;
}

export function avatarEntryName(packIndex: number, mime: string | null): string {
  return `${AVATAR_DIRECTORY}/${String(packIndex)}.${extensionFor(mime)}`;
}

export function archivePack(
  draft: PackDraft,
  entryFor: (url: string) => string | undefined
): ArchivePack {
  const images: Record<string, ArchiveImage> = {};
  for (const image of draft.images) {
    const file = entryFor(image.url);
    if (file === undefined) continue;

    images[image.shortcode] = {
      file,
      body: image.body ?? undefined,
      usage: imageUsageContent(image.usage, draft.usage),
      info: infoContent(image.info),
    };
  }

  return {
    pack: {
      display_name: draft.name === '' ? undefined : draft.name,
      avatar_file: draft.avatarUrl === null ? undefined : entryFor(draft.avatarUrl),
      attribution: draft.attribution === '' ? undefined : draft.attribution,
      usage: usageContent(draft.usage),
    },
    images,
  };
}

export function manifestJson(packs: ArchivePack[]): string {
  return JSON.stringify({ version: ARCHIVE_VERSION, packs }, null, 2);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function readString(value: unknown): string | undefined {
  return typeof value === 'string' && value !== '' ? value : undefined;
}

function readNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function readUsage(value: unknown): ImageUsageView[] | undefined {
  if (!Array.isArray(value)) return undefined;

  const usage = ALL_USAGES.filter((entry) => value.includes(entry));
  return usage.length > 0 ? usage : undefined;
}

function readInfo(value: unknown): PackImageInfoContent | undefined {
  if (!isRecord(value)) return undefined;

  const info: PackImageInfoContent = {
    w: readNumber(value.w),
    h: readNumber(value.h),
    mimetype: readString(value.mimetype),
    size: readNumber(value.size),
  };

  return Object.values(info).some((entry) => entry !== undefined) ? info : undefined;
}

function readImages(value: unknown): Record<string, ArchiveImage> {
  const images: Record<string, ArchiveImage> = {};
  if (!isRecord(value)) return images;

  for (const [shortcode, entry] of Object.entries(value)) {
    const wanted = normalizeShortcode(shortcode);
    const image = isRecord(entry) ? entry : {};
    const file = readString(image.file);
    if (wanted === '' || wanted.length > MAX_SHORTCODE_LENGTH || file === undefined) continue;

    images[wanted] = {
      file,
      body: readString(image.body),
      usage: readUsage(image.usage),
      info: readInfo(image.info),
    };
  }

  return images;
}

export function parseManifest(text: string): ArchivePack[] {
  const parsed: unknown = JSON.parse(text);
  if (!isRecord(parsed)) throw new Error('The manifest is not an object');
  if (parsed.version !== ARCHIVE_VERSION) throw new Error('Unsupported archive version');
  if (!Array.isArray(parsed.packs)) throw new Error('The manifest lists no packs');

  return parsed.packs.filter(isRecord).map((pack) => {
    const meta = isRecord(pack.pack) ? pack.pack : {};
    return {
      pack: {
        display_name: readString(meta.display_name),
        avatar_file: readString(meta.avatar_file),
        attribution: readString(meta.attribution),
        usage: readUsage(meta.usage),
      },
      images: readImages(pack.images),
    };
  });
}

export function archiveImages(
  pack: ArchivePack,
  urlFor: (file: string) => string | undefined
): PackImageDraft[] {
  return Object.entries(pack.images).flatMap(([shortcode, image]) => {
    const url = urlFor(image.file);
    if (url === undefined) return [];

    return [
      {
        shortcode,
        url,
        body: image.body ?? null,
        usage: image.usage ?? pack.pack.usage ?? ALL_USAGES,
        info: {
          width: image.info?.w ?? null,
          height: image.info?.h ?? null,
          mimetype: image.info?.mimetype ?? null,
          size: image.info?.size ?? null,
        },
      },
    ];
  });
}
