import { decode, encode } from 'blurhash';

const ENCODE_COMPONENTS_X = 4;
const ENCODE_COMPONENTS_Y = 3;
const ENCODE_MAX_DIMENSION = 32;

export function encodeBlurhash(bitmap: ImageBitmap): string | null {
  if (typeof document === 'undefined' || bitmap.width <= 0 || bitmap.height <= 0) return null;

  const scale = Math.min(1, ENCODE_MAX_DIMENSION / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));

  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext('2d');
  if (!context) return null;

  context.drawImage(bitmap, 0, 0, width, height);
  const { data } = context.getImageData(0, 0, width, height);
  return encode(data, width, height, ENCODE_COMPONENTS_X, ENCODE_COMPONENTS_Y);
}

export function decodeBlurhashPixels(
  hash: string,
  width: number,
  height: number
): Uint8ClampedArray | null {
  try {
    return decode(hash, width, height);
  } catch {
    return null;
  }
}

export function paintBlurhash(
  canvas: HTMLCanvasElement,
  hash: string,
  width: number,
  height: number
): boolean {
  const context = canvas.getContext('2d');
  if (!context) return false;

  const pixels = decodeBlurhashPixels(hash, width, height);
  if (!pixels) return false;

  canvas.width = width;
  canvas.height = height;
  const image = context.createImageData(width, height);
  image.data.set(pixels);
  context.putImageData(image, 0, 0);
  return true;
}

export function blurhashDataUrl(hash: string, width: number, height: number): string | null {
  if (typeof document === 'undefined') return null;

  const canvas = document.createElement('canvas');
  return paintBlurhash(canvas, hash, width, height) ? canvas.toDataURL() : null;
}
