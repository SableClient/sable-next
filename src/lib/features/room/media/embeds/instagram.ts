const HOSTS = new Set(['instagram.com', 'www.instagram.com']);
const CODE = /^[\w-]{5,64}$/;
const HANDLE = /^[\w.]{1,30}$/;

export type InstagramKind = 'p' | 'reel' | 'tv';

export interface InstagramPost {
  code: string;
  kind: InstagramKind;
}

const KINDS: Partial<Record<string, InstagramKind>> = {
  p: 'p',
  reel: 'reel',
  reels: 'reel',
  tv: 'tv',
};

export function parseInstagramLink(href: string): InstagramPost | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (!HOSTS.has(url.hostname)) return null;

  const segments = url.pathname.replace(/\/$/, '').split('/').slice(1);
  if (segments.length === 3) {
    if (!HANDLE.test(segments[0] ?? '')) return null;
    segments.shift();
  }
  if (segments.length !== 2) return null;
  const [kind = '', code = ''] = segments;
  const mapped = KINDS[kind];
  if (!mapped || !CODE.test(code)) return null;
  return { code, kind: mapped };
}

export function instagramEmbedUrl(post: InstagramPost): string {
  const kind = post.kind === 'reel' ? 'reel' : 'p';
  return `https://www.instagram.com/${kind}/${post.code}/embed/`;
}
