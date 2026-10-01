import { parseFavorites } from '#lib/features/gif/favorites.svelte.js';
import { V1_MIGRATION_ENABLED } from './config.js';
import { convertV1SyncedSettings } from './preferences.js';

export const v1SettingsFallback = V1_MIGRATION_ENABLED
  ? { eventType: 'moe.sable.app.settings', convert: convertV1SyncedSettings }
  : undefined;
export const v1WorkspaceFallback = V1_MIGRATION_ENABLED
  ? { eventType: 'moe.sable.favorite_gifs', convert: convertV1Workspace }
  : undefined;

export function convertV1Workspace(content: unknown): unknown {
  if (content === null || typeof content !== 'object' || Array.isArray(content)) return null;
  const gifs = (content as Record<string, unknown>).gifs;
  if (!Array.isArray(gifs)) return null;
  const normalized = gifs.map((entry: unknown) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) return entry;
    const gif = entry as Record<string, unknown>;
    const url = gif.mediaUrl ?? gif.url;
    return { ...gif, mediaUrl: legacyKlipyUrl(url) ?? url };
  });
  return { v: 1, favoriteGifs: parseFavorites(normalized) };
}

function legacyKlipyUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  try {
    const url = new URL(value);
    if (
      url.protocol !== 'mxc:' ||
      url.hostname !== 'gifs.sable.moe' ||
      url.port ||
      url.username ||
      url.password ||
      url.search ||
      url.hash ||
      !url.pathname.startsWith('/klipy_')
    )
      return undefined;
    const encoded = url.pathname.slice('/klipy_'.length);
    if (!/^[A-Za-z0-9_-]+$/.test(encoded)) return undefined;
    const binary = atob(encoded.replaceAll('-', '+').replaceAll('_', '/'));
    const path = new TextDecoder().decode(Uint8Array.from(binary, (char) => char.charCodeAt(0)));
    return `https://static.klipy.com/ii/${path}`;
  } catch {
    return undefined;
  }
}
