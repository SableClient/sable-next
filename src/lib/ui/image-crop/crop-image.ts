import { MAX_CANVAS_PIXELS } from '#lib/ui/canvas-limits.js';

import { type Rect, type Rotation, rotatedSize } from './geometry.js';

const KEPT_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp']);
/** Photo formats a canvas cannot re-encode, so opaque ones become JPEG rather than PNG. */
const PHOTO_TYPES = new Set(['image/heic', 'image/heif']);
const EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
};

export interface Crop {
  /** In the pixels of the upright source after `rotation`. */
  rect: Rect;
  rotation: Rotation;
  maxEdge?: number;
}

function isOpaque(context: CanvasRenderingContext2D, { width, height }: HTMLCanvasElement) {
  const rows = Math.max(1, Math.floor(1_048_576 / width));
  for (let y = 0; y < height; y += rows) {
    const { data } = context.getImageData(0, y, width, Math.min(rows, height - y));
    for (let i = 3; i < data.length; i += 4) if (data[i] !== 255) return false;
  }
  return true;
}

export async function cropImage(file: File, { rect, rotation, maxEdge }: Crop): Promise<File> {
  const bitmap = await createImageBitmap(file, {
    imageOrientation: 'from-image',
  });
  try {
    const scale = Math.min(
      1,
      maxEdge ? maxEdge / Math.max(rect.width, rect.height) : 1,
      Math.sqrt(MAX_CANVAS_PIXELS / (rect.width * rect.height))
    );
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(rect.width * scale));
    canvas.height = Math.max(1, Math.round(rect.height * scale));
    const context = canvas.getContext('2d');
    if (!context) throw new Error('No canvas context');
    const turned = rotatedSize(bitmap, rotation);
    context.imageSmoothingQuality = 'high';
    context.scale(scale, scale);
    context.translate(turned.width / 2 - rect.x, turned.height / 2 - rect.y);
    context.rotate((rotation * Math.PI) / 180);
    context.drawImage(bitmap, -bitmap.width / 2, -bitmap.height / 2);

    const type = KEPT_TYPES.has(file.type)
      ? file.type
      : PHOTO_TYPES.has(file.type) && isOpaque(context, canvas)
        ? 'image/jpeg'
        : 'image/png';
    const blob = await new Promise<Blob | null>((resolve) => {
      canvas.toBlob(resolve, type, 0.92);
    });
    if (!blob) throw new Error('The cropped image could not be encoded');
    const stem = file.name.replace(/\.[^.]*$/, '') || 'image';
    return new File([blob], stem + (EXTENSIONS[blob.type] ?? ''), {
      type: blob.type,
      lastModified: Date.now(),
    });
  } finally {
    bitmap.close();
  }
}
