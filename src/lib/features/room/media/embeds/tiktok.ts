const HOSTS = new Set(['tiktok.com', 'www.tiktok.com', 'm.tiktok.com']);
const SHORT_HOSTS = new Set(['vm.tiktok.com', 'vt.tiktok.com']);
const SHORT_CODE = /^[\w-]{4,32}$/;
const POST_ID = /^\d{10,25}$/;
const HANDLE = /^@[\w.]{1,64}$/;

export interface TiktokPost {
  id: string;
  author: string | null;
}

export function parseTiktokLink(href: string): TiktokPost | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!HOSTS.has(url.hostname)) return null;

  const segments = url.pathname.split('/');
  if (segments.length !== 4) return null;
  const [, handle = '', kind, id = ''] = segments;
  if (!HANDLE.test(handle) || (kind !== 'video' && kind !== 'photo') || !POST_ID.test(id)) {
    return null;
  }
  return { id, author: handle };
}

export function tiktokPlayerUrl(post: TiktokPost): string {
  const url = new URL(`https://www.tiktok.com/player/v1/${post.id}`);
  url.searchParams.set('autoplay', '1');
  return url.href;
}

export function isTiktokShortLink(href: string): boolean {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return false;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return false;
  const segments = url.pathname.split('/').filter(Boolean);
  if (SHORT_HOSTS.has(url.hostname)) {
    return segments.length === 1 && SHORT_CODE.test(segments[0] ?? '');
  }
  if (HOSTS.has(url.hostname)) {
    return segments.length === 2 && segments[0] === 't' && SHORT_CODE.test(segments[1] ?? '');
  }
  return false;
}

const resolved = new Map<string, Promise<TiktokPost | null>>();

async function fetchShortLink(href: string): Promise<TiktokPost | null> {
  const url = new URL('https://www.tiktok.com/oembed');
  url.searchParams.set('url', href);
  const response = await fetch(url);
  if (!response.ok) return null;
  const body = (await response.json()) as { html?: unknown; author_url?: unknown };
  if (typeof body.html !== 'string') return null;
  const id = /data-video-id="(\d+)"/.exec(body.html)?.[1];
  if (!id || !POST_ID.test(id)) return null;
  const handle =
    typeof body.author_url === 'string' ? (body.author_url.split('/').pop() ?? '') : '';
  return { id, author: HANDLE.test(handle) ? handle : null };
}

export function resolveTiktokShortLink(href: string): Promise<TiktokPost | null> {
  const cached = resolved.get(href);
  if (cached) return cached;

  const promise = fetchShortLink(href).catch((error: unknown) => {
    console.warn('[sable tiktok embed] unavailable', href, error);
    return null;
  });
  resolved.set(href, promise);
  return promise;
}
