import { parseMatrixLink } from './matrix-link';

function isPreviewable(href: string): boolean {
  if (parseMatrixLink(href)) return false;
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

export function previewableLinks(html: string): string[] {
  if (!html.includes('<a')) return [];
  const links = new Set<string>();
  const document = new DOMParser().parseFromString(html, 'text/html');
  for (const anchor of document.querySelectorAll('a[href]')) {
    if (anchor.closest('pre, code, span[data-mx-spoiler]')) continue;
    const href = anchor.getAttribute('href') ?? '';
    if (isPreviewable(href)) links.add(href);
  }
  return [...links];
}
