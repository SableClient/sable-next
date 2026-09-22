const VIDEO_HOSTS = new Set([
  'youtube.com',
  'www.youtube.com',
  'm.youtube.com',
  'music.youtube.com',
]);
const VIDEO_ID = /^[\w-]{11}$/;
const TIMESTAMP = /^(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s?)?$/;

export interface YoutubeVideo {
  id: string;
  start: number | null;
}

export interface YoutubeDetails {
  title: string;
  author: string | null;
}

function parseStart(value: string | null): number | null {
  if (!value) return null;
  const match = TIMESTAMP.exec(value);
  if (!match) return null;
  const [, hours = '0', minutes = '0', seconds = '0'] = match;
  const total = Number(hours) * 3600 + Number(minutes) * 60 + Number(seconds);
  return total > 0 ? total : null;
}

function videoId(url: URL): string | null {
  if (url.hostname === 'youtu.be') return url.pathname.slice(1);
  if (!VIDEO_HOSTS.has(url.hostname)) return null;
  if (url.pathname === '/watch') return url.searchParams.get('v');
  if (url.pathname.startsWith('/shorts/')) return url.pathname.split('/')[2] ?? null;
  return null;
}

export function parseYoutubeLink(href: string): YoutubeVideo | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;

  const id = videoId(url);
  if (id === null || !VIDEO_ID.test(id)) return null;

  return {
    id,
    start: parseStart(url.searchParams.get('t') ?? url.searchParams.get('start')),
  };
}

export function youtubePlayerUrl(video: YoutubeVideo): string {
  const url = new URL(`https://www.youtube-nocookie.com/embed/${video.id}`);
  url.searchParams.set('autoplay', '1');
  if (video.start !== null) url.searchParams.set('start', String(video.start));
  return url.href;
}

export function youtubeThumbnailUrl(video: YoutubeVideo): string {
  return `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`;
}

const details = new Map<string, Promise<YoutubeDetails | null>>();

async function fetchDetails(id: string): Promise<YoutubeDetails | null> {
  const url = new URL('https://www.youtube.com/oembed');
  url.searchParams.set('format', 'json');
  url.searchParams.set('url', `https://www.youtube.com/watch?v=${id}`);
  const response = await fetch(url);
  if (!response.ok) return null;
  const body = (await response.json()) as { title?: unknown; author_name?: unknown };
  if (typeof body.title !== 'string') return null;
  return {
    title: body.title,
    author: typeof body.author_name === 'string' ? body.author_name : null,
  };
}

export function loadYoutubeDetails(id: string): Promise<YoutubeDetails | null> {
  const cached = details.get(id);
  if (cached) return cached;

  const promise = fetchDetails(id).catch((error: unknown) => {
    console.warn('[sable youtube embed] unavailable', id, error);
    return null;
  });
  details.set(id, promise);
  return promise;
}
