import { gifFromUploadedMxc, type GifResult } from '#lib/gif/providers.js';
import { appMime } from '#lib/mime.js';
import { topicToHtml } from '#lib/model/model.js';
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

export function isGifPreview(url: string, preview: UrlPreviewView | null): boolean {
  return preview?.video?.gif === true || preview?.image_mime === 'image/gif' || isGifHostUrl(url);
}

type PreviewGif = {
  media: { source: string; filename: string; mime: string | null };
  favorite: GifResult | undefined;
};

function lastPathSegment(url: string): string {
  try {
    return new URL(url).pathname.split('/').filter(Boolean).at(-1) ?? '';
  } catch {
    return '';
  }
}

function previewFilename(url: string, mime: string | null): string {
  const stem = lastPathSegment(url).replace(/\.[^.]+$/, '') || 'gif';
  return `${stem}.${(mime !== null && appMime.getExtension(mime)) || 'gif'}`;
}

export function previewGif(previews: readonly UrlPreviewView[]): PreviewGif | null {
  for (const preview of previews) {
    if (!isGifPreview(preview.url, preview)) continue;
    if (preview.video) {
      const { source, mime } = preview.video;
      return {
        media: { source, filename: previewFilename(preview.url, mime), mime },
        favorite: undefined,
      };
    }
    if (preview.image) {
      const mime = preview.image_mime ?? imageMimeFromUrl(preview.url) ?? 'image/gif';
      const filename = previewFilename(preview.url, mime);
      return {
        media: { source: preview.image, filename, mime },
        favorite: gifFromUploadedMxc(
          preview.image,
          filename,
          preview.image_width,
          preview.image_height,
          null,
          mime,
          true
        ),
      };
    }
  }
  return null;
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

const HIDDEN_LINK_CONTEXT = 'pre, code, span[data-mx-spoiler]';

function previewableHref(anchor: Element, body: string): string | null {
  const href = anchor.getAttribute('href') ?? '';
  return !anchor.closest(HIDDEN_LINK_CONTEXT) &&
    !bracketed(anchor) &&
    isPreviewable(href) &&
    !body.includes(`<${href}>`)
    ? href
    : null;
}

export function previewableLinks(html: string, body = ''): string[] {
  if (!html.includes('<a')) return [];
  const links = new Set<string>();
  const document = new DOMParser().parseFromString(html, 'text/html');
  for (const anchor of document.querySelectorAll('a[href]')) {
    const href = previewableHref(anchor, body);
    if (href !== null) links.add(href);
  }
  return [...links];
}

export function outgoingPreviewableLinks(html: string | null, body: string): string[] {
  const links = new Set<string>();
  const addBareLinks = (text: string) => {
    if (!/https?:\/\//iu.test(text)) return;
    for (const href of previewableLinks(topicToHtml(text), body)) {
      if (text.includes(href)) links.add(href);
    }
  };
  if (html === null) {
    addBareLinks(body);
  } else {
    const document = new DOMParser().parseFromString(html, 'text/html');
    const walker = document.createTreeWalker(
      document.body,
      NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT
    );
    for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) {
      if (node instanceof Element && node.matches('a[href]')) {
        const href = previewableHref(node, body);
        if (href !== null) links.add(href);
      } else if (
        node.nodeType === Node.TEXT_NODE &&
        !node.parentElement?.closest(`a, ${HIDDEN_LINK_CONTEXT}, mx-reply, script, style, textarea`)
      ) {
        addBareLinks(node.textContent ?? '');
      }
    }
  }
  return [...links];
}
