import { invoke } from '@tauri-apps/api/core';

import { mimeFromName } from './files.js';
import { isAndroid, isNativeMobile } from './os.js';

export interface RecentMedia {
  id: string;
  kind: 'image' | 'video';
  name: string;
  duration: number;
}

/** `unasked` on Android also covers a refusal, which the system does not tell apart. */
export type MediaAccess = 'granted' | 'limited' | 'unasked' | 'denied';

export interface RecentMediaList {
  access: MediaAccess;
  items: RecentMedia[];
}

/** Lists what is already readable; `request` shows the system prompt first. */
export async function recentMedia(limit = 24, request = false): Promise<RecentMediaList> {
  if (!isNativeMobile()) return { access: 'denied', items: [] };
  try {
    return await invoke<RecentMediaList>('recent_media', { limit, request });
  } catch (error) {
    console.debug('[sable files] recent media unavailable', error);
    return { access: 'denied', items: [] };
  }
}

export async function recentMediaThumbnail(media: RecentMedia, size: number): Promise<Blob | null> {
  try {
    const bytes = isAndroid()
      ? await (
          await import('tauri-plugin-android-fs-api')
        ).getFileThumbnail(media.id, { width: size, height: size, format: 'jpeg' })
      : await invoke<ArrayBuffer>('recent_media_thumbnail', { id: media.id, size });
    return bytes && new Blob([bytes], { type: 'image/jpeg' });
  } catch (error) {
    console.debug('[sable files] recent media thumbnail failed', media.id, error);
    return null;
  }
}

export async function recentMediaFile(media: RecentMedia): Promise<File> {
  const bytes = isAndroid()
    ? await (await import('tauri-plugin-android-fs-api')).readFile(media.id)
    : await invoke<ArrayBuffer>('recent_media_file', { id: media.id });
  const name = media.name || 'attachment';
  return new File([bytes], name, { type: mimeFromName(name) });
}
