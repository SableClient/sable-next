import type { PixelatedImages } from '#lib/settings/preferences.svelte.js';

export const SMART_PIXELATED_LIMIT = 192;

export function pixelatedImage(
  mode: PixelatedImages,
  width: number | null | undefined,
  height: number | null | undefined
): boolean {
  if (mode !== 'smart') return mode === 'always';
  if (!width || !height) return false;
  return width < SMART_PIXELATED_LIMIT || height < SMART_PIXELATED_LIMIT;
}
