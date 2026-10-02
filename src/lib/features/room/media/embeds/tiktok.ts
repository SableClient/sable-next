const HOSTS = new Set(['tiktok.com', 'www.tiktok.com', 'm.tiktok.com']);
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
