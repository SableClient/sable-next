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

export function invalidShortcode(images: PackImageDraft[]): string | null {
  const seen = new Set<string>();
  for (const image of images) {
    if (!/^[a-zA-Z0-9_-]{1,100}$/u.test(image.shortcode) || seen.has(image.shortcode)) {
      return image.shortcode;
    }
    seen.add(image.shortcode);
  }
  return null;
}

export function readPackUsage(pack: unknown): ImageUsageView[] {
  const declared =
    typeof pack === 'object' && pack !== null ? (pack as { usage?: unknown }).usage : undefined;
  if (!Array.isArray(declared)) return ALL_USAGES;
  const usage = ALL_USAGES.filter((entry) => declared.includes(entry));
  return usage.length === 0 ? ALL_USAGES : usage;
}

export function imageContent(
  image: PackImageDraft,
  packUsage: ImageUsageView[]
): Record<string, unknown> {
  return {
    url: image.url,
    body: image.body ?? undefined,
    usage: imageUsageContent(image.usage, packUsage),
    info: infoContent(image.info),
  };
}

export function packEventContent(draft: PackDraft): Record<string, unknown> {
  const rejected = invalidShortcode(draft.images);
  if (rejected !== null) throw new Error(`Invalid or duplicate shortcode: ${rejected}`);
  return {
    pack: {
      display_name: draft.name === '' ? undefined : draft.name,
      avatar_url: draft.avatarUrl ?? undefined,
      attribution: draft.attribution === '' ? undefined : draft.attribution,
      usage: usageContent(draft.usage),
    },
    images: Object.fromEntries(
      draft.images.map((image) => [image.shortcode, imageContent(image, draft.usage)])
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
  const base = normalizeShortcode(shortcode) || 'image';
  const candidateFor = (index: number): string => {
    const tail = `-${String(index)}`;
    return `${base.slice(0, MAX_SHORTCODE_LENGTH - tail.length)}${tail}`;
  };
  let candidate = candidateFor(suffix);
  while (taken(candidate)) {
    suffix += 1;
    candidate = candidateFor(suffix);
  }
  return candidate;
}

export function uniqueShortcode(shortcode: string, taken: (candidate: string) => boolean): string {
  const normalized = normalizeShortcode(shortcode) || 'image';
  return taken(normalized) ? suffixRename(normalized, taken) : normalized;
}

export function shortcodeWithoutExtension(fileName: string): string {
  const dot = fileName.lastIndexOf('.');
  return dot > 0 ? fileName.slice(0, dot) : fileName;
}
