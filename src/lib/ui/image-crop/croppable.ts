import { imageMime } from '#lib/media-signatures.js';
import { imageIsAnimated } from '#lib/model/model.js';

/**
 * Canvas cropping keeps only the first frame of an animation, and Chromium
 * cannot decode SVG to a bitmap, so those upload as they are.
 */
export async function isCroppable(file: Blob): Promise<boolean> {
  const bytes = new Uint8Array(await file.arrayBuffer());
  return imageMime(bytes) !== 'image/svg+xml' && imageIsAnimated(bytes) !== true;
}
