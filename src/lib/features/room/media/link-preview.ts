import { parseMatrixLink } from '#lib/rooms/matrix-link.js';
import type { UrlPreviewView, VideoPlaybackView } from '#src/generated/protocol';

import { parseSettingsLink } from '../settings/settings-link';

export const GIF_PLAYBACK: VideoPlaybackView = {
  gif: true,
  autoplay: true,
  looping: true,
  hide_controls: true,
  no_audio: true,
};

const GIF_HOSTS = ['tenor.com', 'giphy.com', 'klipy.com'];

export function isGifHostUrl(href: string): boolean {
  try {
    const { hostname } = new URL(href);
    return GIF_HOSTS.some((host) => hostname === host || hostname.endsWith(`.${host}`));
  } catch {
    return false;
  }
}

export function hasPreviewData(preview: UrlPreviewView): boolean {
  return [
    preview.title,
    preview.description,
    preview.site_name,
    preview.image,
    preview.video,
    preview.post,
  ].some((value) => value !== null);
}

export function previewWhitelistEntry(url: string): UrlPreviewView {
  return {
    url,
    title: null,
    description: null,
    site_name: null,
    image: null,
    image_mime: null,
    image_width: null,
    image_height: null,
    video: null,
    theme_color: null,
    card: null,
    author_name: null,
    post: null,
  };
}

function isPreviewable(href: string): boolean {
  if (parseMatrixLink(href) || parseSettingsLink(href, location.origin)) return false;
  try {
    const url = new URL(href);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

const IMAGE_MIMES: Record<string, string> = {
  apng: 'image/apng',
  avif: 'image/avif',
  gif: 'image/gif',
  webp: 'image/webp',
};

export function imageMimeFromUrl(href: string): string | null {
  let path: string;
  try {
    path = new URL(href).pathname;
  } catch {
    return null;
  }
  const extension = path.slice(path.lastIndexOf('.') + 1).toLowerCase();
  return IMAGE_MIMES[extension] ?? null;
}

function bracketed(anchor: Element): boolean {
  const before = anchor.previousSibling;
  const after = anchor.nextSibling;
  return (
    before?.nodeType === Node.TEXT_NODE &&
    after?.nodeType === Node.TEXT_NODE &&
    (before.textContent ?? '').endsWith('<') &&
    (after.textContent ?? '').startsWith('>')
  );
}

export function previewableLinks(html: string, body = ''): string[] {
  if (!html.includes('<a')) return [];
  const links = new Set<string>();
  const document = new DOMParser().parseFromString(html, 'text/html');
  for (const anchor of document.querySelectorAll('a[href]')) {
    if (anchor.closest('pre, code, span[data-mx-spoiler]') || bracketed(anchor)) continue;
    const href = anchor.getAttribute('href') ?? '';
    if (isPreviewable(href) && !body.includes(`<${href}>`)) links.add(href);
  }
  return [...links];
}
