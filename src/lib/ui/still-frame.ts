import { windowActivity } from '#lib/platform/window-activity.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

const held = new WeakMap<HTMLImageElement, { source: string; still: string }>();

export function animationsPaused(): boolean {
  return preferences.pauseAnimationsWhenInactive && !windowActivity.active;
}

export function stillFrame(image: HTMLImageElement): string | null {
  if (!image.complete || image.naturalWidth === 0) return null;
  const canvas = document.createElement('canvas');
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext('2d');
  if (!context) return null;
  try {
    context.drawImage(image, 0, 0);
    return canvas.toDataURL();
  } catch {
    return null;
  }
}

export function holdStillFrame(image: HTMLImageElement, paused: boolean): void {
  const frame = held.get(image);
  if (!paused) {
    if (frame && image.src === frame.still) image.src = frame.source;
    return;
  }
  if (!image.src || image.src === frame?.still) return;
  if (image.src === frame?.source) {
    image.src = frame.still;
    return;
  }
  const still = stillFrame(image);
  if (!still) return;
  held.set(image, { source: image.src, still });
  image.src = still;
}
