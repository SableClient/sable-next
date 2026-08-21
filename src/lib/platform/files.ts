import { invoke, isTauri } from '@tauri-apps/api/core';

export type SaveOutcome = 'saved' | 'cancelled' | 'failed';

/**
 * A blob `<a download>` is a no-op in WKWebView and unreliable in Android's
 * WebView, so under Tauri the bytes go out through the native save dialog.
 */
export function savesNatively(): boolean {
  return isTauri();
}

/** Desktop webviews open `<input type="file">` themselves; mobile ones do not. */
export async function picksNatively(): Promise<boolean> {
  if (!isTauri()) return false;
  const { type } = await import('@tauri-apps/plugin-os');
  const os = type();
  return os === 'android' || os === 'ios';
}

export async function saveFile(url: string, filename: string): Promise<SaveOutcome> {
  try {
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const { type } = await import('@tauri-apps/plugin-os');
    if (type() === 'android') {
      await saveAndroidFile('Download', filename, mimeFromName(filename), bytes);
      return 'saved';
    }

    const [{ save }, { writeFile }] = await Promise.all([
      import('@tauri-apps/plugin-dialog'),
      import('@tauri-apps/plugin-fs'),
    ]);

    const path = await save({ defaultPath: filename });
    if (path === null) return 'cancelled';

    await writeFile(path, bytes);
    return 'saved';
  } catch (error) {
    console.debug('[sable files] save failed', error);
    return 'failed';
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
    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    const { type } = await import('@tauri-apps/plugin-os');
    if (type() === 'android') {
      await saveAndroidFile('Pictures', filename, mime, bytes);
      return 'saved';
    }
    if (type() === 'ios') {
      await invoke('save_media_to_photos', { bytes: Array.from(bytes), filename, mimeType: mime });
      return 'saved';
    }
  } catch (error) {
    console.debug('[sable files] save to photos failed', error);
    return 'failed';
  }
  return 'failed';
}

async function saveAndroidFile(
  directory: 'Download' | 'Pictures',
  filename: string,
  mime: string,
  bytes: Uint8Array
): Promise<void> {
  const AndroidFs = await import('tauri-plugin-android-fs-api');
  const uri =
    directory === 'Pictures'
      ? await AndroidFs.createNewPublicImageFile(
          AndroidFs.PublicImageDir.Pictures,
          filename,
          mime,
          {
            isPending: true,
            requestPermission: true,
          }
        )
      : await AndroidFs.createNewPublicFile(
          AndroidFs.PublicGeneralPurposeDir.Download,
          filename,
          mime,
          { isPending: true, requestPermission: true }
        );
  try {
    await AndroidFs.writeFile(uri, bytes);
    await AndroidFs.setPublicFilePending(uri, false);
    await AndroidFs.scanPublicFile(uri);
  } catch (error) {
    await AndroidFs.removeFile(uri).catch(() => {});
    throw error;
  }
}

const MIME_BY_EXTENSION: Record<string, string> = {
  aac: 'audio/aac',
  avif: 'image/avif',
  flac: 'audio/flac',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  jpeg: 'image/jpeg',
  jpg: 'image/jpeg',
  m4a: 'audio/mp4',
  m4v: 'video/mp4',
  mov: 'video/quicktime',
  mp3: 'audio/mpeg',
  mp4: 'video/mp4',
  oga: 'audio/ogg',
  ogg: 'audio/ogg',
  ogv: 'video/ogg',
  opus: 'audio/opus',
  pdf: 'application/pdf',
  png: 'image/png',
  svg: 'image/svg+xml',
  txt: 'text/plain',
  wav: 'audio/wav',
  webm: 'video/webm',
  webp: 'image/webp',
};

export function fileNameFromPath(path: string, index: number): string {
  return path.split(/[\\/]/).pop() || `attachment-${String(index + 1)}`;
}

/** The native picker hands back a path, which carries no media type. */
export function mimeFromName(name: string): string {
  const extension = name.includes('.') ? name.split('.').pop()?.toLowerCase() : undefined;
  return (extension && MIME_BY_EXTENSION[extension]) || 'application/octet-stream';
}

/** `null` when the caller should fall back to `<input type="file">`. */
export async function pickFiles(accept: string): Promise<File[] | null> {
  if (!(await picksNatively())) return null;

  try {
    const { type } = await import('@tauri-apps/plugin-os');
    return await (type() === 'android' ? pickAndroidFiles(accept) : pickIosFiles(accept));
  } catch (error) {
    console.debug('[sable files] native pick failed', error);
    return null;
  }
}

async function pickAndroidFiles(accept: string): Promise<File[]> {
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
          return null;
        }
      })
  );
  return files.filter((file): file is File => file !== null);
}

async function pickIosFiles(accept: string): Promise<File[]> {
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

/** Maps an `accept` attribute onto the extension lists the native dialog wants. */
export function filtersFor(accept: string): { name: string; extensions: string[] }[] | undefined {
  const wanted = accept
    .split(',')
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);
  if (wanted.length === 0 || wanted.includes('*/*')) return undefined;

  const extensions = Object.entries(MIME_BY_EXTENSION)
    .filter(([, mime]) =>
      wanted.some((entry) =>
        entry.endsWith('/*') ? mime.startsWith(entry.slice(0, -1)) : entry === mime
      )
    )
    .map(([extension]) => extension);

  return extensions.length > 0 ? [{ name: 'Supported', extensions }] : undefined;
}
