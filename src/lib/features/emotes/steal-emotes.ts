import type { ImageUsageView, TimelineItemContentView } from '#src/generated/protocol';

import { imageMime } from '#lib/ui/media-url.js';

import type { PackTransferCore } from './pack-transfer.js';
import {
  infoContent,
  normalizeShortcode,
  shortcodeWithoutExtension,
  uniqueShortcode,
  usageContent,
  type PackImageDraft,
} from './pack-content.js';

export interface EmoteCandidate {
  source: string;
  shortcode: string;
  body: string | null;
  width: number | null;
  height: number | null;
  mime: string | null;
  usage: ImageUsageView[];
}

function suggestedShortcode(raw: string | null, fallback: string): string {
  const wanted = normalizeShortcode(shortcodeWithoutExtension(raw ?? ''));
  return wanted === '' ? fallback : wanted;
}

function dimension(value: string | null): number | null {
  const parsed = Number(value);
  return value !== null && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function inlineEmotes(html: string): EmoteCandidate[] {
  const document = new DOMParser().parseFromString(html, 'text/html');
  const found = new Map<string, EmoteCandidate>();

  for (const image of document.querySelectorAll('img[data-mx-emoticon]')) {
    const source = image.getAttribute('src') ?? '';
    if (!source.startsWith('mxc://') || found.has(source)) continue;

    const label = image.getAttribute('alt') ?? image.getAttribute('title');
    found.set(source, {
      source,
      shortcode: suggestedShortcode(label, 'emote'),
      body: label,
      width: dimension(image.getAttribute('width')),
      height: dimension(image.getAttribute('height')),
      mime: null,
      usage: ['emoticon'],
    });
  }

  return [...found.values()];
}

export function emoteCandidates(content: TimelineItemContentView): EmoteCandidate[] {
  if (content.kind === 'sticker') {
    return [
      {
        source: content.source,
        shortcode: suggestedShortcode(content.body, 'sticker'),
        body: content.body === '' ? null : content.body,
        width: content.width,
        height: content.height,
        mime: content.mime,
        usage: ['sticker'],
      },
    ];
  }

  return 'html' in content && content.html !== null ? inlineEmotes(content.html) : [];
}

export async function uploadCandidates(
  core: PackTransferCore,
  picks: EmoteCandidate[]
): Promise<PackImageDraft[]> {
  const added: PackImageDraft[] = [];
  for (const pick of picks) {
    const bytes = await core.commands.fetchMedia(pick.source, 0, 0);
    const mimetype = pick.mime ?? imageMime(bytes) ?? null;
    added.push({
      shortcode: pick.shortcode,
      url: await core.commands.uploadMedia(mimetype ?? 'application/octet-stream', bytes),
      body: pick.body,
      usage: pick.usage,
      info: { width: pick.width, height: pick.height, mimetype, size: bytes.length },
    });
  }
  return added;
}

export function mergedPackContent(
  current: unknown,
  additions: PackImageDraft[]
): Record<string, unknown> {
  const pack: Record<string, unknown> =
    typeof current === 'object' && current !== null ? { ...current } : {};
  const held = pack.images;
  const images: Record<string, unknown> =
    typeof held === 'object' && held !== null ? { ...held } : {};

  for (const image of additions) {
    const shortcode = uniqueShortcode(image.shortcode, (candidate) => candidate in images);
    images[shortcode] = {
      url: image.url,
      body: image.body ?? undefined,
      usage: usageContent(image.usage),
      info: infoContent(image.info),
    };
  }

  return { ...pack, images };
}
