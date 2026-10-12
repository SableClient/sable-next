import type {
  ImagePackView,
  ImageUsageView,
  PackDraftView,
  PackImageDraftView,
  PackImageInfoView,
} from '#src/generated/protocol';

export {
  invalidShortcode,
  normalizeShortcode,
  shortcodeWithoutExtension,
  uniqueShortcode,
} from '#lib/model/model.js';

export const ALL_USAGES: ImageUsageView[] = ['emoticon', 'sticker'];

export type PackImageDraft = PackImageDraftView;

export type PackDraft = PackDraftView;

export function packDraft(pack: ImagePackView): PackDraft {
  return {
    name: pack.declared_name ?? '',
    avatar_url: pack.declared_avatar_url,
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
  return { name: '', avatar_url: null, attribution: '', usage: ALL_USAGES, images: [] };
}

export const MAX_SHORTCODE_LENGTH = 100;

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

export function setImageUsage(
  draft: PackDraft,
  shortcode: string,
  usage: ImageUsageView[]
): PackDraft {
  return {
    ...draft,
    images: draft.images.map((image) =>
      image.shortcode === shortcode ? { ...image, usage } : image
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
