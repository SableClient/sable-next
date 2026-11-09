import { base64ToString, stringToBase64 } from 'uint8array-extras';
import * as v from 'valibot';

import { isRecord } from '#lib/guards.js';
import { appMime } from '#lib/mime.js';

export const gifProviderIds = ['klipy', 'tenor', 'giphy'] as const;

export type GifProviderId = (typeof gifProviderIds)[number];

export type GifsConfig = {
  provider: GifProviderId | null;
  proxyUrl: string | null;
  klipyApiKey: string | null;
  tenorApiKey: string | null;
  giphyApiKey: string | null;
};

export type GifResult = {
  id: string;
  title: string;
  mediaUrl: string;
  previewUrl: string;
  width: number;
  height: number;
  size: number;
  mimetype: string;
};

export type GifProvider = {
  id: GifProviderId;
  label: string;
  apiKey: (config: GifsConfig) => string | null;
  searchUrl: (apiKey: string, query: string) => string;
  parse: (payload: unknown) => GifResult[];
  isMediaUrlAllowed: (url: URL) => boolean;
  proxyPayload: (url: URL, gif: GifResult) => string | undefined;
};

const resultLimit = 50;

const readString = v.parser(v.fallback(v.string(), ''));
const readRecord = v.parser(v.fallback(v.custom<Record<string, unknown>>(isRecord), {}));
const readId = v.parser(v.fallback(v.union([v.string(), v.number()]), ''));

const sizeLimit = 3 * 1024 * 1024;

function positiveInt(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : undefined;
}

function urlExtension(url: URL): string {
  const dot = url.pathname.lastIndexOf('.');
  return dot === -1 ? '' : url.pathname.slice(dot + 1).toLowerCase();
}

const gifMimetypes = new Set(['image/gif', 'image/webp']);
const animatedImageMimetypes = new Set(['image/webp', 'image/apng', 'image/avif']);

function mimetypeOf(mediaUrl: string): string {
  try {
    const type = appMime.getType(new URL(mediaUrl).pathname);
    return type !== null && gifMimetypes.has(type) ? type : 'image/gif';
  } catch {
    return 'image/gif';
  }
}

function idBeforeFilename(url: URL): string | undefined {
  return url.pathname.split('/').filter(Boolean).at(-2);
}

function isPlainHttpsUrl(url: URL): boolean {
  return url.protocol === 'https:' && url.port === '' && url.username === '' && url.password === '';
}

type GifFile = { url: string; width?: number; height?: number; size?: number };

function toFile(url: unknown, width: unknown, height: unknown, size: unknown): GifFile | undefined {
  return typeof url === 'string' && url !== ''
    ? {
        url,
        width: positiveInt(width),
        height: positiveInt(height),
        size: positiveInt(size),
      }
    : undefined;
}

function pickFullRes(candidates: (GifFile | undefined)[]): GifFile | undefined {
  const available = candidates.filter((file): file is GifFile => file !== undefined);
  return (
    available.find((file) => !file.size || file.size <= sizeLimit) ??
    available.reduce<GifFile | undefined>(
      (smallest, file) => (smallest && (smallest.size ?? 0) <= (file.size ?? 0) ? smallest : file),
      undefined
    )
  );
}

function toResult(
  id: string,
  title: string,
  fullRes: GifFile | undefined,
  preview: GifFile | undefined
): GifResult {
  const mediaUrl = fullRes?.url ?? '';

  return {
    id,
    title: title || 'GIF',
    mediaUrl,
    previewUrl: preview?.url ?? fullRes?.url ?? '',
    width: fullRes?.width ?? preview?.width ?? 0,
    height: fullRes?.height ?? preview?.height ?? 0,
    size: fullRes?.size ?? preview?.size ?? 0,
    mimetype: mimetypeOf(mediaUrl),
  };
}

function klipyFormat(format: unknown): GifFile | undefined {
  const gif = readRecord(readRecord(format).gif);
  return toFile(gif.url, gif.width, gif.height, gif.size);
}

function parseKlipy(payload: unknown): GifResult[] {
  const results = readRecord(readRecord(payload).data).data;
  if (!Array.isArray(results)) return [];

  return results.filter(isRecord).map((result) => {
    const formats = readRecord(result.file);
    const preview = klipyFormat(formats.xs) ?? klipyFormat(formats.sm) ?? klipyFormat(formats.md);
    const fullRes = pickFullRes([klipyFormat(formats.hd), klipyFormat(formats.md)]) ?? preview;
    return toResult(String(readId(result.id)), readString(result.title), fullRes, preview);
  });
}

function tenorFormat(formats: Record<string, unknown>, key: string): GifFile | undefined {
  const format = readRecord(formats[key]);
  const dims = Array.isArray(format.dims) ? format.dims : [];
  return toFile(format.url, dims[0], dims[1], format.size);
}

function parseTenor(payload: unknown): GifResult[] {
  const results = readRecord(payload).results;
  if (!Array.isArray(results)) return [];

  return results.filter(isRecord).map((result) => {
    const formats = readRecord(result.media_formats);
    const preview = tenorFormat(formats, 'tinygif') ?? tenorFormat(formats, 'nanogif');
    const fullRes =
      pickFullRes([tenorFormat(formats, 'gif'), tenorFormat(formats, 'mediumgif')]) ?? preview;
    const title = readString(result.content_description) || readString(result.title);

    return toResult(readString(result.id), title, fullRes, preview);
  });
}

function giphyRendition(images: Record<string, unknown>, key: string): GifFile | undefined {
  const rendition = readRecord(images[key]);
  return toFile(rendition.url, rendition.width, rendition.height, rendition.size);
}

function parseGiphy(payload: unknown): GifResult[] {
  const results = readRecord(payload).data;
  if (!Array.isArray(results)) return [];

  return results.filter(isRecord).map((result) => {
    const images = readRecord(result.images);
    const preview = giphyRendition(images, 'fixed_width') ?? giphyRendition(images, 'preview_gif');
    const fullRes =
      giphyRendition(images, 'original') ?? giphyRendition(images, 'downsized') ?? preview;

    return toResult(readString(result.id), readString(result.title), fullRes, preview);
  });
}

export const gifProviders: Record<GifProviderId, GifProvider> = {
  klipy: {
    id: 'klipy',
    label: 'Klipy',
    apiKey: (config) => config.klipyApiKey,
    searchUrl: (apiKey, query) => {
      const url = new URL(`https://api.klipy.com/api/v1/${encodeURIComponent(apiKey)}/gifs/search`);
      url.searchParams.set('q', query);
      url.searchParams.set('per_page', String(resultLimit));
      return url.toString();
    },
    parse: parseKlipy,
    isMediaUrlAllowed: (url) =>
      isPlainHttpsUrl(url) && url.hostname === 'static.klipy.com' && /^\/ii\/.+/.test(url.pathname),
    proxyPayload: (url) => url.pathname.slice('/ii/'.length) || undefined,
  },
  tenor: {
    id: 'tenor',
    label: 'Tenor',
    apiKey: (config) => config.tenorApiKey,
    searchUrl: (apiKey, query) => {
      const url = new URL('https://tenor.googleapis.com/v2/search');
      url.searchParams.set('key', apiKey);
      /* Any other client_key is a 403 worded as "Tenor API is discontinued". */
      url.searchParams.set('client_key', 'tenor_web');
      url.searchParams.set('q', query);
      url.searchParams.set('limit', String(resultLimit));
      url.searchParams.set('media_filter', 'gif,mediumgif,tinygif,nanogif');
      return url.toString();
    },
    parse: parseTenor,
    isMediaUrlAllowed: (url) =>
      isPlainHttpsUrl(url) && /^(?:c|media\d*)\.tenor\.com$/.test(url.hostname),
    proxyPayload: (url) => idBeforeFilename(url),
  },
  giphy: {
    id: 'giphy',
    label: 'Giphy',
    apiKey: (config) => config.giphyApiKey,
    searchUrl: (apiKey, query) => {
      const url = new URL('https://api.giphy.com/v1/gifs/search');
      url.searchParams.set('api_key', apiKey);
      url.searchParams.set('q', query);
      url.searchParams.set('limit', String(resultLimit));
      return url.toString();
    },
    parse: parseGiphy,
    isMediaUrlAllowed: (url) =>
      isPlainHttpsUrl(url) && /^(?:i|media\d*)\.giphy\.com$/.test(url.hostname),
    proxyPayload: (url, gif) => {
      const id = gif.id || idBeforeFilename(url);
      return id ? `${id}.${urlExtension(url) || 'gif'}` : undefined;
    },
  },
};

const defaultProviderId: GifProviderId = 'tenor';

export type GifProviderSetting = GifProviderId | 'default';

function configuredProvider(config: GifsConfig): GifProvider {
  const id = config.provider;
  return (id === null ? undefined : gifProviders[id]) ?? gifProviders[defaultProviderId];
}

export function gifProvider(
  config: GifsConfig,
  override: GifProviderSetting = 'default'
): GifProvider {
  const picked = override === 'default' ? undefined : gifProviders[override];
  return picked?.apiKey(config) ? picked : configuredProvider(config);
}

export function gifProviderLabel(config: GifsConfig, id: GifProviderSetting): string {
  return id === 'default' ? configuredProvider(config).label : gifProviders[id].label;
}

export function gifSearchAvailable(
  config: GifsConfig,
  override: GifProviderSetting = 'default'
): boolean {
  return gifProvider(config, override).apiKey(config) !== null && config.proxyUrl !== null;
}

export type ProxiedGif = { mxcUrl: string; mimetype: string };

const uploadedMxc = /^mxc:\/\/[^/]+\/[^/]+$/;

export function isUploadedGifSource(value: string): boolean {
  return uploadedMxc.test(value) && !proxiedMxc.test(value);
}

export function gifFromUploadedMxc(
  source: string,
  filename: string,
  width: number | null,
  height: number | null,
  size: number | null,
  mimetype: string | null,
  animated: boolean | null = null
): GifResult | undefined {
  const moving =
    mimetype === 'image/gif' || (animated === true && animatedImageMimetypes.has(mimetype ?? ''));
  if (!moving || mimetype === null || !isUploadedGifSource(source)) return undefined;

  return {
    id: '',
    title: filename.replace(/\.[^.]+$/, '') || 'GIF',
    mediaUrl: source,
    previewUrl: source,
    width: width ?? 0,
    height: height ?? 0,
    size: size ?? 0,
    mimetype,
  };
}

export function proxiedGif(gif: GifResult, proxyUrl: string | null): ProxiedGif | undefined {
  if (isUploadedGifSource(gif.mediaUrl)) return { mxcUrl: gif.mediaUrl, mimetype: gif.mimetype };

  const server = proxyUrl?.trim();
  if (!server) return undefined;

  let url: URL;
  try {
    url = new URL(gif.mediaUrl);
  } catch {
    return undefined;
  }

  const provider = Object.values(gifProviders).find((candidate) =>
    candidate.isMediaUrlAllowed(url)
  );
  const payload = provider?.proxyPayload(url, gif);
  if (!provider || !payload) return undefined;

  return {
    mxcUrl: `mxc://${server}/${provider.id}_${stringToBase64(payload, { urlSafe: true })}`,
    mimetype: gif.mimetype,
  };
}

const proxiedMxc = /^mxc:\/\/[^/]+\/(klipy|tenor|giphy)_([A-Za-z0-9_-]+)$/;

function providerMediaUrl(provider: string, payload: string): { url: string; id: string } {
  if (provider === 'klipy') return { url: `https://static.klipy.com/ii/${payload}`, id: '' };
  if (provider === 'tenor') return { url: `https://c.tenor.com/${payload}/tenor.gif`, id: '' };
  const dot = payload.lastIndexOf('.');
  const id = dot === -1 ? payload : payload.slice(0, dot);
  return {
    url: `https://i.giphy.com/media/${id}/giphy${dot === -1 ? '.gif' : payload.slice(dot)}`,
    id,
  };
}

export function gifFromProxiedMxc(
  source: string,
  filename: string,
  width: number | null,
  height: number | null,
  size: number | null,
  mimetype: string | null
): GifResult | undefined {
  const match = proxiedMxc.exec(source);
  if (!match) return undefined;

  let payload: string;
  try {
    payload = base64ToString(match[2]);
  } catch {
    return undefined;
  }
  const { url, id } = providerMediaUrl(match[1], payload);
  if (!isAllowedGifMediaUrl(url)) return undefined;

  return {
    id,
    title: filename.replace(/\.[^.]+$/, '') || 'GIF',
    mediaUrl: url,
    previewUrl: url,
    width: width ?? 0,
    height: height ?? 0,
    size: size ?? 0,
    mimetype: mimetype ?? mimetypeOf(url),
  };
}

export function gifFilename(title: string, mimetype: string): string {
  const ext = (gifMimetypes.has(mimetype) && appMime.getExtension(mimetype)) || 'gif';
  const stem = title.replace(/[\s/\\:*?"<>|]+/g, '-').replace(/^-+|-+$/g, '') || 'gif';

  return stem.endsWith(`.${ext}`) ? stem : `${stem}.${ext}`;
}

export function isAllowedGifMediaUrl(value: string): boolean {
  if (isUploadedGifSource(value)) return true;
  try {
    const url = new URL(value);
    return Object.values(gifProviders).some((provider) => provider.isMediaUrlAllowed(url));
  } catch {
    return false;
  }
}
