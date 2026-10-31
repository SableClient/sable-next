import { isTauri } from '@tauri-apps/api/core';

import { imageMime as sniffImageMime } from '#lib/media-signatures.js';
import { appMime } from '#lib/mime.js';

import { electronBridge } from './electron.js';
import type { FileFilter } from './file-dialog-types.js';
import { isNativeMobile } from './os.js';
import { rawInvoke } from './raw-invoke.js';

export type SaveOutcome = 'saved' | 'cancelled' | 'failed';

/**
 * A blob `<a download>` fails in WKWebView and Android's WebView, so the native apps save through the
 * native dialog. Electron opens one too, over IPC.
 */
export function savesNatively(): boolean {
  return isTauri() || electronBridge() !== undefined;
}

/** Desktop webviews open `<input type="file">` themselves; mobile ones do not. */
export async function picksNatively(): Promise<boolean> {
  if (!isTauri()) return false;
  const { type } = await import('@tauri-apps/plugin-os');
  const os = type();
  return os === 'android' || os === 'ios';
}

export function capturesFromCamera(): boolean {
  if (isNativeMobile()) return true;
  return !isTauri() && typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches;
}

export async function saveFile(
  url: string,
  filename: string,
  askLocation = true
): Promise<SaveOutcome> {
  try {
    const blob = await (await fetch(url)).blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const mime =
      [mimeFromName(filename), blob.type, sniffImageMime(bytes) ?? ''].find(
        (candidate) => candidate !== '' && candidate !== 'application/octet-stream'
      ) ?? 'application/octet-stream';
    const name = withExtension(safeFileName(filename), mime);

    const electron = electronBridge();
    if (electron) {
      const saved = await electron.saveFile({
        name,
        bytes,
        filters: filtersFor(mime) ?? [],
        askLocation,
      });
      return saved === null ? 'cancelled' : 'saved';
    }

    const { type } = await import('@tauri-apps/plugin-os');
    if (type() === 'android') {
      await saveAndroidFile('Download', name, mime, bytes);
      return 'saved';
    }

    const [{ save }, { writeFile }] = await Promise.all([
      import('@tauri-apps/plugin-dialog'),
      import('@tauri-apps/plugin-fs'),
    ]);

    const path = await save({ defaultPath: name });
    if (path === null) return 'cancelled';

    await writeFile(path, bytes);
    return 'saved';
  } catch (error) {
    console.debug('[sable files] save failed', error);
    return 'failed';
  }
}

export async function saveUrl(
  url: string,
  filename: string,
  askLocation = true
): Promise<SaveOutcome> {
  if (savesNatively()) return saveFile(url, filename, askLocation);

  const link = document.createElement('a');
  link.href = url;
  link.download = filename;
  link.click();
  return 'saved';
}

export async function saveBytes(
  bytes: Uint8Array<ArrayBuffer>,
  filename: string,
  mime: string,
  askLocation = true
): Promise<SaveOutcome> {
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  try {
    return await saveUrl(url, filename, askLocation);
  } finally {
    URL.revokeObjectURL(url);
  }
}

export async function supportsPhotoLibrary(): Promise<boolean> {
  if (!isTauri()) return false;
  const { type } = await import('@tauri-apps/plugin-os');
  const os = type();
  return os === 'android' || os === 'ios';
}

export async function saveImageToPhotos(
  url: string,
  filename: string,
  mime = mimeFromName(filename)
): Promise<SaveOutcome> {
  try {
    const blob = await (await fetch(url)).blob();
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const imageMime =
      [mime, blob.type, sniffImageMime(bytes) ?? ''].find((candidate) =>
        candidate.startsWith('image/')
      ) ?? mime;
    const name = withExtension(safeFileName(filename), imageMime);
    const { type } = await import('@tauri-apps/plugin-os');
    if (type() === 'android') {
      await saveAndroidFile('Pictures', name, imageMime, bytes);
      return 'saved';
    }
    if (type() === 'ios') {
      await rawInvoke('save_media_to_photos', bytes, { filename: name, 'mime-type': imageMime });
      return 'saved';
    }
  } catch (error) {
    console.debug('[sable files] save to photos failed', error);
    return 'failed';
  }
  return 'failed';
}

export async function saveVideoToPhotos(
  url: string,
  filename: string,
  mime = mimeFromName(filename)
): Promise<SaveOutcome> {
  try {
    const blob = await (await fetch(url)).blob();
    const videoMime =
      [mime, blob.type, mimeFromName(filename)].find((value) => value.startsWith('video/')) ??
      'video/mp4';
    const bytes = new Uint8Array(await blob.arrayBuffer());
    const name = withExtension(safeFileName(filename), videoMime);
    await rawInvoke('save_media_to_photos', bytes, { filename: name, 'mime-type': videoMime });
    return 'saved';
  } catch (error) {
    console.debug('[sable files] save video to photos failed', error);
    return 'failed';
  }
}

export function sharesNatively(): boolean {
  const electron = electronBridge();
  return electron ? electron.platform === 'darwin' : isNativeMobile();
}

export async function shareFile(
  url: string,
  filename: string,
  mime = mimeFromName(filename),
  anchor?: DOMRect
): Promise<SaveOutcome> {
  try {
    const name = filename.split(/[\\/]/).pop() || 'attachment';
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const electron = electronBridge();
    if (electron) {
      await electron.shareFile({ name, bytes });
      return 'saved';
    }
    const [{ appCacheDir, join }, { mkdir, remove, writeFile }, { shareFile: shareNative }] =
      await Promise.all([
        import('@tauri-apps/api/path'),
        import('@tauri-apps/plugin-fs'),
        import('@choochmeque/tauri-plugin-sharekit-api'),
      ]);

    const directory = await join(await appCacheDir(), 'outgoing-share');
    await mkdir(directory, { recursive: true });
    const path = await join(directory, cacheName(name));
    await writeFile(path, bytes);

    try {
      await shareNative(path, {
        mimeType: mime,
        title: name,
        position: anchor && { x: anchor.left, y: anchor.top },
      });
    } finally {
      await remove(path).catch((error: unknown) => {
        console.debug('[sable files] shared temp file not removed', path, error);
      });
    }
    return 'saved';
  } catch (error) {
    console.debug('[sable files] share failed', error);
    return 'failed';
  }
}

function cacheName(name: string): string {
  const safe = name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[.-]+/, '');
  return safe || 'attachment';
}

function timestamped(name: string): string {
  const dot = name.lastIndexOf('.');
  const stamp = `-${String(Date.now())}`;
  return dot > 0 ? `${name.slice(0, dot)}${stamp}${name.slice(dot)}` : `${name}${stamp}`;
}

async function saveAndroidFile(
  directory: 'Download' | 'Pictures',
  filename: string,
  mime: string,
  bytes: Uint8Array
): Promise<void> {
  const AndroidFs = await import('tauri-plugin-android-fs-api');
  const create = (name: string) =>
    directory === 'Pictures'
      ? AndroidFs.createNewPublicImageFile(AndroidFs.PublicImageDir.Pictures, name, mime, {
          isPending: true,
          requestPermission: true,
        })
      : AndroidFs.createNewPublicFile(AndroidFs.PublicGeneralPurposeDir.Download, name, mime, {
          isPending: true,
          requestPermission: true,
        });
  const save = async (name: string): Promise<void> => {
    const uri = await create(name);
    try {
      await AndroidFs.writeFile(uri, bytes);
      await AndroidFs.setPublicFilePending(uri, false);
      await AndroidFs.scanPublicFile(uri);
    } catch (error) {
      await AndroidFs.removeFile(uri).catch((removeError: unknown) => {
        console.debug('[sable files] partial Android file not removed', removeError);
      });
      throw error;
    }
  };
  // MediaStore tries only 32 numbered variants of a name, and a pending file
  // takes its final name only when the flag is cleared, so the whole save retries.
  await save(filename).catch((error: unknown) => {
    console.debug('[sable files] public file name is taken, retrying', error);
    return save(timestamped(filename));
  });
}

export function fileNameFromPath(path: string, index: number): string {
  return path.split(/[\\/]/).pop() || `attachment-${String(index + 1)}`;
}

/** The native picker hands back a path, which carries no media type. */
function safeFileName(name: string): string {
  return name.replace(/[\\/:*?"<>|]/gu, '_').trim() || 'file';
}

function withExtension(filename: string, mimeType: string): string {
  if (mimeFromName(filename) === mimeType) return filename;
  const extension = appMime.getExtension(mimeType);
  return extension ? `${filename}.${extension}` : filename;
}

export function mimeFromName(name: string): string {
  return (name.includes('.') ? appMime.getType(name) : null) ?? 'application/octet-stream';
}

const AMBIGUOUS_MIMES = new Set(['', 'application/octet-stream', 'application/ogg']);

export function withResolvedMime(file: File): File {
  if (!AMBIGUOUS_MIMES.has(file.type)) return file;
  const mime = mimeFromName(file.name);
  if (mime === 'application/octet-stream') return file;
  return new File([file], file.name, { type: mime, lastModified: file.lastModified });
}

/** `null` when the caller should fall back to `<input type="file">`. */
export async function pickFiles(
  accept: string,
  onFailure?: (error: unknown) => void
): Promise<File[] | null> {
  const electron = electronBridge();
  if (electron) {
    try {
      const picked = await electron.pickFiles({
        filters: filtersFor(accept) ?? [],
        multiple: true,
      });
      if (picked === null) return [];
      return picked.map(({ name, bytes }) => new File([bytes], name, { type: mimeFromName(name) }));
    } catch (error) {
      console.debug('[sable files] native pick failed', error);
      onFailure?.(error);
      return [];
    }
  }

  if (!(await picksNatively())) return null;

  try {
    const { type } = await import('@tauri-apps/plugin-os');
    return await (type() === 'android'
      ? pickAndroidFiles(accept, onFailure)
      : pickIosFiles(accept, onFailure));
  } catch (error) {
    console.debug('[sable files] native pick failed', error);
    onFailure?.(error);
    return [];
  }
}

async function pickAndroidFiles(
  accept: string,
  onFailure?: (error: unknown) => void
): Promise<File[]> {
  const AndroidFs = await import('tauri-plugin-android-fs-api');
  const documents = accept === '*' || accept === '*/*';
  const selected = await AndroidFs.showOpenFilePicker({
    pickerType: documents ? 'FilePicker' : 'Gallery',
    mimeTypes: documents ? [] : accept.split(','),
    multiple: true,
  });
  const seen = new Set<string>();
  const files = await Promise.all(
    selected
      .filter(({ uri }) => !seen.has(uri) && Boolean(seen.add(uri)))
      .map(async (uri, index) => {
        try {
          const metadata = await AndroidFs.getMetadata(uri);
          if (metadata.type !== 'File') return null;

          const name = metadata.name || `attachment-${String(index + 1)}`;
          const bytes = await AndroidFs.readFile(uri);
          return new File([bytes], name, {
            type:
              metadata.mimeType && metadata.mimeType !== 'application/octet-stream'
                ? metadata.mimeType
                : mimeFromName(name),
            lastModified: metadata.lastModified.getTime(),
          });
        } catch (error) {
          console.debug('[sable files] Android file read failed', uri.uri, error);
          onFailure?.(error);
          return null;
        }
      })
  );
  return files.filter((file): file is File => file !== null);
}

async function pickIosFiles(accept: string, onFailure?: (error: unknown) => void): Promise<File[]> {
  const [{ open }, { readFile, remove }] = await Promise.all([
    import('@tauri-apps/plugin-dialog'),
    import('@tauri-apps/plugin-fs'),
  ]);
  const documents = accept === '*' || accept === '*/*';
  const selected = await open({
    multiple: true,
    pickerMode: documents ? 'document' : 'media',
    filters: filtersFor(accept),
  });
  if (selected === null) return [];

  const paths = Array.isArray(selected) ? selected : [selected];
  const files = await Promise.all(
    paths.map(async (path, index) => {
      const name = fileNameFromPath(path, index);
      try {
        const bytes = await readFile(path);
        return new File([bytes], name, { type: mimeFromName(name) });
      } catch (error) {
        console.debug('[sable files] iOS file read failed', path, error);
        onFailure?.(error);
        return null;
      } finally {
        await remove(path).catch((error: unknown) => {
          console.debug('[sable files] iOS picker cleanup failed', path, error);
        });
      }
    })
  );
  return files.filter((file): file is File => file !== null);
}

const WILDCARD_EXTENSIONS: Record<string, string[]> = {
  audio: ['mp3', 'm4a', 'aac', 'ogg', 'oga', 'opus', 'flac', 'wav', 'weba'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'apng', 'heic', 'heif', 'svg'],
  video: ['mp4', 'm4v', 'mov', 'webm', 'mkv', 'ogv', '3gp'],
};

/** Maps an `accept` attribute onto the extension lists the native dialog wants. */
export function filtersFor(accept: string): FileFilter[] | undefined {
  const wanted = accept
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (wanted.length === 0 || wanted.includes('*/*') || wanted.includes('*')) return undefined;

  const extensions = new Set<string>();
  for (const entry of wanted) {
    if (entry.startsWith('.') && entry.length > 1) {
      extensions.add(entry.slice(1));
      continue;
    }
    const wildcard = entry.endsWith('/*') ? WILDCARD_EXTENSIONS[entry.slice(0, -2)] : undefined;
    for (const extension of wildcard ?? appMime.getAllExtensions(entry) ?? []) {
      extensions.add(extension);
    }
  }

  return extensions.size > 0 ? [{ name: 'Supported', extensions: [...extensions] }] : undefined;
}
