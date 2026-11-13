import { invoke } from '@tauri-apps/api/core';

import { mimeFromName } from './files.js';
import { isAndroid, isNativeMobile } from './os.js';

export interface RecentMedia {
  id: string;
  kind: 'image' | 'video';
  name: string;
  duration: number;
}

/** Asks for photo library access on first use, and resolves to nothing when it is refused. */
export async function recentMedia(limit = 24): Promise<RecentMedia[]> {
  if (!isNativeMobile()) return [];
  try {
    return await invoke<RecentMedia[]>('recent_media', { limit });
  } catch (error) {
    console.debug('[sable files] recent media unavailable', error);
    return [];
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
