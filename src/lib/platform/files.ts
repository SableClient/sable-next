import { isTauri } from '@tauri-apps/api/core';

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
    const [{ save }, { writeFile }] = await Promise.all([
      import('@tauri-apps/plugin-dialog'),
      import('@tauri-apps/plugin-fs'),
    ]);

    const path = await save({ defaultPath: filename });
    if (path === null) return 'cancelled';

    const bytes = new Uint8Array(await (await fetch(url)).arrayBuffer());
    await writeFile(path, bytes);
    return 'saved';
  } catch (error) {
    console.debug('[sable files] save failed', error);
    return 'failed';
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
    const [{ open }, { readFile }] = await Promise.all([
      import('@tauri-apps/plugin-dialog'),
      import('@tauri-apps/plugin-fs'),
    ]);

    const selected = await open({ multiple: true, filters: filtersFor(accept) });
    if (selected === null) return [];

    const paths = Array.isArray(selected) ? selected : [selected];
    return await Promise.all(
      paths.map(async (path, index) => {
        const name = fileNameFromPath(path, index);
        const bytes = await readFile(path);
        return new File([bytes], name, { type: mimeFromName(name) });
      })
    );
  } catch (error) {
    console.debug('[sable files] native pick failed', error);
    return null;
  }
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
