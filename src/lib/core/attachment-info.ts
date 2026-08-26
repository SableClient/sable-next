import type { AttachmentInfoView } from '#src/generated/AttachmentInfoView';

const MEASURE_TIMEOUT_MS = 5_000;

type Size = { width: number; height: number };

export async function measureAttachment(file: Blob): Promise<AttachmentInfoView | null> {
  const kind = file.type.split('/')[0];

  if (kind === 'image') {
    const size = await imageSize(file);
    return size === null ? null : { ...size, duration_ms: null, animated: animated(file.type) };
  }

  if (kind === 'video' || kind === 'audio') {
    const metadata = await mediaMetadata(file, kind);
    if (metadata === null) return null;
    return { ...metadata, animated: null };
  }

  return null;
}

function animated(mime: string): boolean | null {
  if (mime === 'image/gif') return true;
  if (mime === 'image/webp' || mime === 'image/apng') return null;
  return false;
}

async function imageSize(file: Blob): Promise<Size | null> {
  if (typeof createImageBitmap !== 'function') return null;

  try {
    const bitmap = await createImageBitmap(file);
    try {
      return { width: bitmap.width, height: bitmap.height };
    } finally {
      bitmap.close();
    }
  } catch (error) {
    console.debug('[sable media] the image could not be decoded to measure it', error);
    return null;
  }
}

type MediaMetadata = {
  width: number | null;
  height: number | null;
  duration_ms: number | null;
};

async function mediaMetadata(file: Blob, kind: 'video' | 'audio'): Promise<MediaMetadata | null> {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return null;

  const url = URL.createObjectURL(file);
  const element = document.createElement(kind);
  element.preload = 'metadata';
  element.muted = true;

  try {
    await metadataLoaded(element, url);

    const metadata: MediaMetadata = {
      width: positive('videoWidth' in element ? element.videoWidth : 0),
      height: positive('videoHeight' in element ? element.videoHeight : 0),
      duration_ms: durationMs(element.duration),
    };

    return metadata.width === null && metadata.duration_ms === null ? null : metadata;
  } catch (error) {
    console.debug('[sable media] the media could not be decoded to measure it', error);
    return null;
  } finally {
    element.removeAttribute('src');
    element.load();
    URL.revokeObjectURL(url);
  }
}

function metadataLoaded(element: HTMLMediaElement, url: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('metadata timed out'));
    }, MEASURE_TIMEOUT_MS);
    const settle = (finish: () => void) => () => {
      clearTimeout(timer);
      finish();
    };

    element.addEventListener('loadedmetadata', settle(resolve), { once: true });
    element.addEventListener(
      'error',
      settle(() => {
        reject(new Error('undecodable media'));
      }),
      { once: true }
    );
    element.src = url;
  });
}

function durationMs(seconds: number): number | null {
  if (!Number.isFinite(seconds) || seconds <= 0) return null;
  return Math.round(seconds * 1000);
}

function positive(value: number): number | null {
  return Number.isFinite(value) && value > 0 ? value : null;
}
