import type { ImagePackView, ImageUsageView, PackImageInfoView } from '#src/generated/protocol';

export const ALL_USAGES: ImageUsageView[] = ['emoticon', 'sticker'];

export interface PackImageDraft {
  shortcode: string;
  url: string;
  body: string | null;
  usage: ImageUsageView[];
  info: PackImageInfoView | null;
}

export interface PackDraft {
  name: string;
  avatarUrl: string | null;
  attribution: string;
  usage: ImageUsageView[];
  images: PackImageDraft[];
}

export function packDraft(pack: ImagePackView): PackDraft {
  return {
    name: pack.name ?? '',
    avatarUrl: pack.avatar_url,
    attribution: pack.attribution ?? '',
    usage: pack.usage,
    images: pack.images.map((image) => ({
      shortcode: image.shortcode,
      url: image.url,
      body: image.body,
      usage: image.usage,
      info: image.info,
    })),
  };
}

export function emptyDraft(): PackDraft {
  return { name: '', avatarUrl: null, attribution: '', usage: ALL_USAGES, images: [] };
}

export const MAX_SHORTCODE_LENGTH = 100;
const SHORTCODE_ALLOWED = /[^a-zA-Z0-9_-]/gu;

export function usageContent(usage: ImageUsageView[]): ImageUsageView[] | undefined {
  return usage.length === ALL_USAGES.length ? undefined : usage;
}

function sameUsage(left: ImageUsageView[], right: ImageUsageView[]): boolean {
  return left.length === right.length && left.every((entry) => right.includes(entry));
}

export function imageUsageContent(
  image: ImageUsageView[],
  pack: ImageUsageView[]
): ImageUsageView[] | undefined {
  return sameUsage(image, pack) ? undefined : image;
}

export function togglePackUsage(
  draft: PackDraft,
  usage: ImageUsageView,
  on: boolean
): PackDraft | null {
  const next = on
    ? ALL_USAGES.filter((entry) => draft.usage.includes(entry) || entry === usage)
    : draft.usage.filter((entry) => entry !== usage);
  if (next.length === 0) return null;

  return {
    ...draft,
    usage: next,
    // images that followed the pack usage move with it, declared exceptions stay
    images: draft.images.map((image) =>
      sameUsage(image.usage, draft.usage) ? { ...image, usage: next } : image
    ),
  };
}

export interface PackImageInfoContent {
  w?: number;
  h?: number;
  mimetype?: string;
  size?: number;
}

export function infoContent(info: PackImageInfoView | null): PackImageInfoContent | undefined {
  if (info === null) return undefined;

  const content: PackImageInfoContent = {};
  if (info.width !== null) content.w = info.width;
  if (info.height !== null) content.h = info.height;
  if (info.mimetype !== null) content.mimetype = info.mimetype;
  if (info.size !== null) content.size = info.size;

  return Object.keys(content).length > 0 ? content : undefined;
}

export function packEventContent(draft: PackDraft): Record<string, unknown> {
  return {
    pack: {
      display_name: draft.name === '' ? undefined : draft.name,
      avatar_url: draft.avatarUrl ?? undefined,
      attribution: draft.attribution === '' ? undefined : draft.attribution,
      usage: usageContent(draft.usage),
    },
    images: Object.fromEntries(
      draft.images.map((image) => [
        image.shortcode,
        {
          url: image.url,
          body: image.body ?? undefined,
          usage: imageUsageContent(image.usage, draft.usage),
          info: infoContent(image.info),
        },
      ])
    ),
  };
}

export function normalizeShortcode(raw: string): string {
  return raw
    .trim()
    .replaceAll(/\s+/gu, '-')
    .replaceAll(SHORTCODE_ALLOWED, '')
    .slice(0, MAX_SHORTCODE_LENGTH);
}

export function suffixRename(shortcode: string, taken: (candidate: string) => boolean): string {
  let suffix = 1;
  let candidate = `${shortcode}-${String(suffix)}`;
  while (taken(candidate)) {
    suffix += 1;
    candidate = `${shortcode}-${String(suffix)}`;
  }
  return candidate;
}

export function uniqueShortcode(shortcode: string, taken: (candidate: string) => boolean): string {
  return taken(shortcode) ? suffixRename(shortcode, taken) : shortcode;
}

export function shortcodeWithoutExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}
