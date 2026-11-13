import { embedServiceUrl } from '#lib/config/embed-service.js';
import { runtimeConfig } from '#lib/config/runtime-config.js';
import type {
  DearrowThumbnailFallback,
  YoutubeThumbnailPosition,
} from '#lib/settings/definitions.js';

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

export interface DearrowDetails {
  title: string | null;
  crowdsourcedThumbnail: number | 'original' | null;
  randomThumbnail: number | null;
}

export interface YoutubeEmbed {
  author: string | null;
  title: string;
  thumbnailUrl: string;
}

// this is a subset of what the API returns
interface DearrowApiTitle {
  title: string;
  votes: number;
  locked: boolean;
}

interface DearrowApiThumbnail {
  timestamp: number | null;
  original: boolean;
  votes: number;
  locked: boolean;
}

interface DearrowApiData {
  titles: DearrowApiTitle[];
  thumbnails: DearrowApiThumbnail[];
  // note: this number is a fraction of the video duration
  //       if the server gives us no video duration, we can't do anything with this
  randomTime: number;
  videoDuration: number | null;
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

export async function youtubePlayerUrl(video: YoutubeVideo): Promise<string> {
  const service = ['http:', 'https:'].includes(location.protocol)
    ? null
    : (await runtimeConfig()).embeds.serviceUrl;
  let url: URL;
  if (service !== null) {
    url = new URL(`${service}/_soliditas/embed/youtube`);
    url.searchParams.set('v', video.id);
  } else {
    url = new URL(`https://www.youtube-nocookie.com/embed/${video.id}`);
    url.searchParams.set('autoplay', '1');
  }
  if (video.start !== null) url.searchParams.set('start', String(video.start));
  return url.href;
}

function thumbnailUrl(
  service: string,
  id: string,
  frame: YoutubeThumbnailPosition | null,
  time: number | null
): string {
  return embedServiceUrl(service, 'embed/youtube/thumbnail', {
    v: id,
    ...(frame !== null && { frame }),
    ...(time !== null && { time: time.toString() }),
  });
}

function dearrowThumbnailUrl(
  service: string,
  id: string,
  dearrow: DearrowDetails | null,
  fallbackType: DearrowThumbnailFallback,
  youtubePosition: YoutubeThumbnailPosition
): string {
  if (dearrow?.crowdsourcedThumbnail === 'original') return thumbnailUrl(service, id, null, null);

  // if the user picks 'random' as the fallback, we should fall back onto youtube thumbnails instead of original
  const fallback = fallbackType === 'original' ? null : youtubePosition;
  const timestamp =
    dearrow?.crowdsourcedThumbnail ??
    (fallbackType === 'random' ? (dearrow?.randomThumbnail ?? null) : null);
  return thumbnailUrl(service, id, fallback, timestamp);
}

const youtubeDetails = new Map<string, Promise<YoutubeDetails | null>>();
const dearrowDetails = new Map<string, Promise<DearrowDetails | null>>();

async function fetchDetails(service: string, id: string): Promise<YoutubeDetails | null> {
  const response = await fetch(embedServiceUrl(service, 'embed/youtube/details', { v: id }));
  if (!response.ok) return null;
  const body = (await response.json()) as { title?: unknown; author_name?: unknown };
  if (typeof body.title !== 'string') return null;
  return {
    title: body.title,
    author: typeof body.author_name === 'string' ? body.author_name : null,
  };
}

async function fetchDearrow(service: string, id: string): Promise<DearrowDetails | null> {
  const response = await fetch(embedServiceUrl(service, 'embed/youtube/dearrow', { v: id }));
  if (response.status !== 200 && response.status !== 404) {
    throw new Error(`DeArrow API returned unexpected status code ${response.status}`);
  }
  const json = (await response.json()) as DearrowApiData;
  const title = json.titles.find((title) => title.votes >= 0 || title.locked);
  const thumbnail = json.thumbnails.find((thumb) => thumb.votes >= 0 || thumb.locked);
  const randomThumbnail = json.videoDuration ? json.videoDuration * json.randomTime : null;

  return {
    title: title?.title ?? null,
    crowdsourcedThumbnail:
      thumbnail?.original === true ? 'original' : (thumbnail?.timestamp ?? null),
    randomThumbnail,
  };
}

function loadYoutubeDetails(service: string, id: string): Promise<YoutubeDetails | null> {
  const cached = youtubeDetails.get(id);
  if (cached) return cached;

  const promise = fetchDetails(service, id).catch((error: unknown) => {
    console.warn('[sable youtube embed] youtube unavailable', id, error);
    return null;
  });
  youtubeDetails.set(id, promise);
  return promise;
}

function loadDearrowDetails(service: string, id: string): Promise<DearrowDetails | null> {
  const cached = dearrowDetails.get(id);
  if (cached) return cached;

  const promise = fetchDearrow(service, id).catch((error: unknown) => {
    console.warn('[sable youtube embed] dearrow unavailable', id, error);
    return null;
  });
  dearrowDetails.set(id, promise);
  return promise;
}

export async function loadDetails(
  id: string,
  useDearrow: boolean,
  fallbackType: DearrowThumbnailFallback,
  youtubePosition: YoutubeThumbnailPosition
): Promise<YoutubeEmbed | null> {
  const service = (await runtimeConfig()).embeds.serviceUrl;
  if (service === null) return null;
  const [youtube, dearrow] = await Promise.all([
    loadYoutubeDetails(service, id),
    useDearrow ? loadDearrowDetails(service, id) : null,
  ]);

  // while we could technically substitute missing youtube data with dearrow data,
  // we'd be adding cases where parts of the embed data are null, and it's better to avoid that entirely
  if (youtube === null) return null;

  // '>' disables the formatter for the following word in dearrow titles, so it is removed.
  const dearrowTitle = dearrow?.title?.replaceAll(/(^| )>/g, '$1');

  return {
    author: youtube.author,
    title: dearrowTitle ?? youtube.title,
    thumbnailUrl: useDearrow
      ? dearrowThumbnailUrl(service, id, dearrow, fallbackType, youtubePosition)
      : thumbnailUrl(service, id, null, null),
  };
}
