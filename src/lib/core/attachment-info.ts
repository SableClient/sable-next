import { encodeBlurhash } from '#lib/ui/blurhash.js';
import type { AttachmentInfoView, AudioMetadataView } from '#src/generated/protocol';
import type { AttachmentThumbnail } from '#src/transport';

const MEASURE_TIMEOUT_MS = 5_000;

type Size = { width: number; height: number; blurhash: string | null };

type Measured = { info: AttachmentInfoView | null; thumbnail: AttachmentThumbnail | null };

const measured = new WeakMap<Blob, Promise<Measured>>();

/** Measured once per file: the composer reads a staged video before it is sent. */
export function measureAttachment(file: Blob): Promise<Measured> {
  let measuring = measured.get(file);
  if (measuring === undefined) {
    measuring = measure(file);
    measured.set(file, measuring);
  }
  return measuring;
}

async function measure(file: Blob): Promise<Measured> {
  const kind = file.type.split('/')[0];

  if (kind === 'image') {
    const size = await imageSize(file);
    return {
      info:
        size === null
          ? null
          : {
              ...size,
              duration_ms: null,
              animated: null,
              waveform: null,
              voice: false,
              audio_metadata: null,
              gif: null,
            },
      thumbnail: null,
    };
  }

  if (kind === 'video' || kind === 'audio') {
    const recorded =
      kind === 'audio' && file instanceof File ? voiceRecordings.get(file) : undefined;
    if (recorded !== undefined) {
      return {
        info: {
          width: null,
          height: null,
          duration_ms: recorded.durationMs,
          animated: null,
          blurhash: null,
          waveform: [...recorded.waveform],
          voice: true,
          audio_metadata: null,
          gif: null,
        },
        thumbnail: null,
      };
    }
    const metadata = await mediaMetadata(file, kind);
    if (metadata === null) return { info: null, thumbnail: null };
    const tags = kind === 'audio' ? await readAudioTags(file) : null;
    return {
      info: {
        width: metadata.width,
        height: metadata.height,
        duration_ms: metadata.duration_ms,
        animated: null,
        blurhash: null,
        waveform: null,
        voice: false,
        audio_metadata: tags,
        gif: null,
      },
      thumbnail: metadata.thumbnail,
    };
  }

  return { info: null, thumbnail: null };
}

export async function readAudioTags(file: Blob): Promise<AudioMetadataView | null> {
  try {
    const { parseBlob } = await import('music-metadata');
    const { common } = await parseBlob(file);
    const picture = common.picture?.[0];
    const cover_art_blurhash = picture ? await coverBlurhash(picture.data, picture.format) : null;
    const text = (value: string | undefined) => value?.trim() || null;
    const tags = {
      title: text(common.title),
      artist: text(common.artist),
      album: text(common.album),
      cover_art_blurhash,
    };
    return Object.values(tags).some((value) => value !== null) ? tags : null;
  } catch (error) {
    console.debug('[sable media] the audio tags could not be read', error);
    return null;
  }
}

async function coverBlurhash(data: Uint8Array, format: string): Promise<string | null> {
  if (typeof createImageBitmap !== 'function') return null;
  try {
    const bitmap = await createImageBitmap(new Blob([data.slice()], { type: format }), {
      imageOrientation: 'from-image',
    });
    try {
      return encodeBlurhash(bitmap);
    } finally {
      bitmap.close();
    }
  } catch {
    return null;
  }
}

const voiceRecordings = new WeakMap<File, { waveform: readonly number[]; durationMs: number }>();

export function markVoiceRecording(
  file: File,
  waveform: readonly number[],
  durationMs: number
): void {
  voiceRecordings.set(file, { waveform, durationMs });
}

async function imageSize(file: Blob): Promise<Size | null> {
  if (typeof createImageBitmap !== 'function') return null;

  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    try {
      let blurhash: string | null = null;
      try {
        blurhash = encodeBlurhash(bitmap);
      } catch (error) {
        console.debug('[sable media] the blurhash could not be encoded', error);
      }
      return { width: bitmap.width, height: bitmap.height, blurhash };
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
  thumbnail: AttachmentThumbnail | null;
};

async function mediaMetadata(file: Blob, kind: 'video' | 'audio'): Promise<MediaMetadata | null> {
  if (typeof document === 'undefined' || typeof URL.createObjectURL !== 'function') return null;

  const url = URL.createObjectURL(file);
  const element = document.createElement(kind);
  element.preload = kind === 'video' ? 'auto' : 'metadata';
  element.muted = true;
  if (element instanceof HTMLVideoElement) element.playsInline = true;

  try {
    await mediaLoaded(element, url, kind === 'video' ? 'loadeddata' : 'loadedmetadata');

    const metadata: MediaMetadata = {
      width: positive('videoWidth' in element ? element.videoWidth : 0),
      height: positive('videoHeight' in element ? element.videoHeight : 0),
      duration_ms: durationMs(element.duration),
      thumbnail: null,
    };
    if (kind === 'video' && metadata.width !== null && metadata.height !== null) {
      metadata.thumbnail = await videoThumbnail(element as HTMLVideoElement);
    }

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

async function videoThumbnail(video: HTMLVideoElement): Promise<AttachmentThumbnail | null> {
  try {
    const scale = Math.min(1, 800 / Math.max(video.videoWidth, video.videoHeight));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(video.videoWidth * scale));
    canvas.height = Math.max(1, Math.round(video.videoHeight * scale));
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(video, 0, 0, canvas.width, canvas.height);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/jpeg', 0.8);
    });
    if (blob === null) return null;
    return {
      bytes: new Uint8Array(await blob.arrayBuffer()),
      width: canvas.width,
      height: canvas.height,
    };
  } catch {
    return null;
  }
}

function mediaLoaded(element: HTMLMediaElement, url: string, event: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error('metadata timed out'));
    }, MEASURE_TIMEOUT_MS);
    const settle = (finish: () => void) => () => {
      clearTimeout(timer);
      finish();
    };

    element.addEventListener(event, settle(resolve), { once: true });
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
