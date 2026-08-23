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
  proxyMimetype: string;
};

const resultLimit = 50;

const sizeLimit = 3 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function positiveInt(value: unknown): number | undefined {
  const parsed = typeof value === 'string' ? Number(value) : value;
  return typeof parsed === 'number' && Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : undefined;
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
  return available.find((file) => !file.size || file.size <= sizeLimit) ?? available.at(-1);
}

function toResult(
  id: string,
  title: string,
  fullRes: GifFile | undefined,
  preview: GifFile | undefined
): GifResult {
  return {
    id,
    title: title || 'GIF',
    mediaUrl: fullRes?.url ?? '',
    previewUrl: preview?.url ?? fullRes?.url ?? '',
    width: fullRes?.width ?? preview?.width ?? 0,
    height: fullRes?.height ?? preview?.height ?? 0,
    size: fullRes?.size ?? preview?.size ?? 0,
    mimetype: 'image/gif',
  };
}

function klipyFormat(format: unknown): GifFile | undefined {
  if (!isRecord(format) || !isRecord(format.gif)) return undefined;
  const { gif } = format;
  return toFile(gif.url, gif.width, gif.height, gif.size);
}

function parseKlipy(payload: unknown): GifResult[] {
  const outer = isRecord(payload) ? payload.data : undefined;
  const results = isRecord(outer) ? outer.data : undefined;
  if (!Array.isArray(results)) return [];

  return results.filter(isRecord).map((result) => {
    const formats = isRecord(result.file) ? result.file : {};
    const preview = klipyFormat(formats.xs) ?? klipyFormat(formats.sm) ?? klipyFormat(formats.md);
    const fullRes = pickFullRes([klipyFormat(formats.hd), klipyFormat(formats.md), preview]);
    const id =
      typeof result.id === 'string' || typeof result.id === 'number' ? String(result.id) : '';

    return toResult(id, typeof result.title === 'string' ? result.title : '', fullRes, preview);
  });
}

function tenorFormat(formats: Record<string, unknown>, key: string): GifFile | undefined {
  const format = formats[key];
  if (!isRecord(format)) return undefined;
  const dims = Array.isArray(format.dims) ? format.dims : [];
  return toFile(format.url, dims[0], dims[1], format.size);
}

function parseTenor(payload: unknown): GifResult[] {
  const results = isRecord(payload) ? payload.results : undefined;
  if (!Array.isArray(results)) return [];

  return results.filter(isRecord).map((result) => {
    const formats = isRecord(result.media_formats) ? result.media_formats : {};
    const preview = tenorFormat(formats, 'tinygif') ?? tenorFormat(formats, 'nanogif');
    const fullRes = pickFullRes([
      tenorFormat(formats, 'gif'),
      tenorFormat(formats, 'mediumgif'),
      preview,
    ]);
    const title =
      (typeof result.content_description === 'string' ? result.content_description : '') ||
      (typeof result.title === 'string' ? result.title : '');

    return toResult(typeof result.id === 'string' ? result.id : '', title, fullRes, preview);
  });
}

function giphyRendition(images: Record<string, unknown>, key: string): GifFile | undefined {
  const rendition = images[key];
  if (!isRecord(rendition)) return undefined;
  return toFile(rendition.url, rendition.width, rendition.height, rendition.size);
}

function parseGiphy(payload: unknown): GifResult[] {
  const results = isRecord(payload) ? payload.data : undefined;
  if (!Array.isArray(results)) return [];

  return results.filter(isRecord).map((result) => {
    const images = isRecord(result.images) ? result.images : {};
    const preview = giphyRendition(images, 'fixed_width') ?? giphyRendition(images, 'preview_gif');
    const fullRes =
      giphyRendition(images, 'original') ?? giphyRendition(images, 'downsized') ?? preview;

    return toResult(
      typeof result.id === 'string' ? result.id : '',
      typeof result.title === 'string' ? result.title : '',
      fullRes,
      preview
    );
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
    proxyMimetype: 'image/gif',
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
    proxyMimetype: 'image/gif',
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
    proxyPayload: (url, gif) => gif.id || idBeforeFilename(url),
    proxyMimetype: 'image/webp',
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

function toBase64Url(value: string): string {
  const bytes = new TextEncoder().encode(value);
  let binary = '';
  for (const byte of bytes) binary += String.fromCodePoint(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}

export type ProxiedGif = { mxcUrl: string; mimetype: string };

export function proxiedGif(gif: GifResult, proxyUrl: string | null): ProxiedGif | undefined {
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
    mxcUrl: `mxc://${server}/${provider.id}_${toBase64Url(payload)}`,
    mimetype: provider.proxyMimetype,
  };
}

const extensions: Record<string, string> = { 'image/gif': 'gif', 'image/webp': 'webp' };

export function gifFilename(title: string, mimetype: string): string {
  const ext = extensions[mimetype] ?? 'gif';
  return title.endsWith(`.${ext}`) ? title : `${title}.${ext}`;
}

export function isAllowedGifMediaUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return Object.values(gifProviders).some((provider) => provider.isMediaUrlAllowed(url));
  } catch {
    return false;
  }
}
