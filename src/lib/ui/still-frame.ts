import { windowActivity } from '#lib/platform/window-activity.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

const STILL_MAX_SIDE = 800;
const STILL_CACHE_SIZE = 256;

const stills = new Map<string, Promise<string | null>>();
const held = new WeakMap<
  HTMLImageElement,
  { source: string; still: string | null; paused: boolean }
>();

export function animationsPaused(): boolean {
  return preferences.pauseAnimationsWhenInactive && !windowActivity.active;
}

async function encodeStill(image: HTMLImageElement): Promise<string | null> {
  const scale = Math.min(1, STILL_MAX_SIDE / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * scale));
  const height = Math.max(1, Math.round(image.naturalHeight * scale));
  try {
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const context = canvas.getContext('2d');
    if (!context) return null;
    context.drawImage(image, 0, 0, width, height);
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, 'image/webp');
    });
    return blob ? URL.createObjectURL(blob) : null;
  } catch {
    return null;
  }
}

export function stillFrame(image: HTMLImageElement, source = image.src): Promise<string | null> {
  if (!image.complete || image.naturalWidth === 0) return Promise.resolve(null);
  const cached = stills.get(source);
  if (cached) {
    stills.delete(source);
    stills.set(source, cached);
    return cached;
  }
  const still = encodeStill(image);
  stills.set(source, still);
  for (const [oldest, evicted] of stills) {
    if (stills.size <= STILL_CACHE_SIZE) break;
    stills.delete(oldest);
    void evicted.then((url) => {
      if (url) URL.revokeObjectURL(url);
    });
  }
  return still;
}

export function holdStillFrame(image: HTMLImageElement, paused: boolean): void {
  const frame = held.get(image);
  if (frame) frame.paused = paused;
  if (!paused) {
    if (frame && image.src === frame.still) image.src = frame.source;
    return;
  }
  if (!image.src || image.src === frame?.still) return;
  const source = image.src;
  const entry = { source, still: null as string | null, paused: true };
  held.set(image, entry);
  void stillFrame(image, source).then((still) => {
    if (!still || !entry.paused || held.get(image) !== entry || image.src !== source) return;
    entry.still = still;
    image.src = still;
  });
}
