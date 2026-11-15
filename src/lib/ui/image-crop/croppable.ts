import { imageMime } from '#lib/media-signatures.js';
import { animatedImage, mayAnimate } from '#lib/ui/media-url.js';

/**
 * Canvas cropping keeps only the first frame of an animation, and Chromium
 * cannot decode SVG to a bitmap, so those upload as they are.
 */
export async function isCroppable(file: Blob): Promise<boolean> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  const type = imageMime(bytes) ?? '';
  return type !== 'image/svg+xml' && (!mayAnimate(type) || animatedImage(type, bytes) === false);
}
