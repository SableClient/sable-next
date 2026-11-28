export interface ImageSize {
  width: number;
  height: number;
}

export interface MockImage extends ImageSize {
  source: string;
}

export const IMAGE_SIZES = {
  wide: { width: 1200, height: 675 },
  square: { width: 1080, height: 1080 },
  tall: { width: 1080, height: 1350 },
  slice: { width: 180, height: 1600 },
} satisfies Record<string, ImageSize>;

const SOURCE = /^mxc:\/\/storybook\.mock\/(\d+)x(\d+)-([\w-]+)$/;
const FALLBACK: ImageSize = { width: 1600, height: 900 };
const MAX_SIDE = 2048;

export function mockImage(width: number, height: number, label = 'image'): string {
  return `mxc://storybook.mock/${String(width)}x${String(height)}-${label}`;
}

export function mockImages(sizes: readonly ImageSize[]): MockImage[] {
  return sizes.map(({ width, height }, index) => ({
    source: mockImage(width, height, `${String(index + 1)}-of-${String(sizes.length)}`),
    width,
    height,
  }));
}

function hue(text: string): number {
  let value = 0;
  for (const character of text) value = (value * 31 + character.charCodeAt(0)) | 0;
  return Math.abs(value) % 360;
}

/* Sources from `mockImage` keep their own size, scaled down like a server thumbnail;
   any other source (generated avatars) fills the requested box. */
function outputSize(source: string, boxWidth: number, boxHeight: number) {
  const match = SOURCE.exec(source);
  const box = boxWidth > 0 && boxHeight > 0 ? { width: boxWidth, height: boxHeight } : null;
  const intrinsic = match
    ? { width: Number(match[1]), height: Number(match[2]) }
    : (box ?? FALLBACK);
  const fit = box ? Math.max(box.width / intrinsic.width, box.height / intrinsic.height) : 1;
  const scale = Math.min(1, fit, MAX_SIDE / Math.max(intrinsic.width, intrinsic.height));
  return {
    intrinsic,
    label: match ? match[3].replaceAll('-', ' ') : '',
    width: Math.max(1, Math.round(intrinsic.width * scale)),
    height: Math.max(1, Math.round(intrinsic.height * scale)),
  };
}

async function draw(source: string, boxWidth: number, boxHeight: number) {
  const { intrinsic, label, width, height } = outputSize(source, boxWidth, boxHeight);
  const canvas = new OffscreenCanvas(width, height);
  const context = canvas.getContext('2d');
  if (!context) throw new Error('2d canvas unavailable');
  const base = hue(source);
  const side = Math.min(width, height);

  context.fillStyle = `hsl(${String(base)} 55% 45%)`;
  context.fillRect(0, 0, width, height);
  context.strokeStyle = `hsl(${String(base)} 60% 70%)`;
  context.lineWidth = Math.max(1, side / 60);
  context.beginPath();
  context.moveTo(0, 0);
  context.lineTo(width, height);
  context.moveTo(width, 0);
  context.lineTo(0, height);
  context.stroke();
  context.strokeRect(0, 0, width, height);

  const lines = [label, `${String(intrinsic.width)}×${String(intrinsic.height)}`].filter(Boolean);
  // Slices read along their long side.
  const across = height > width * 2 ? height : width;
  const fontSize = Math.max(8, Math.min(side / 3, across / 7));
  context.font = `600 ${String(fontSize)}px system-ui, sans-serif`;
  context.textAlign = 'center';
  context.textBaseline = 'middle';
  context.fillStyle = 'white';
  context.translate(width / 2, height / 2);
  if (across !== width) context.rotate(-Math.PI / 2);
  lines.forEach((line, index) => {
    const offset = (index - (lines.length - 1) / 2) * fontSize * 1.2;
    context.fillText(line, 0, offset, across * 0.9);
  });

  const blob = await canvas.convertToBlob({ type: 'image/png' });
  return new Uint8Array(await blob.arrayBuffer());
}

const drawn = new Map<string, Promise<Uint8Array<ArrayBuffer>>>();

export function mockImageBytes(
  source: string,
  width: number,
  height: number
): Promise<Uint8Array<ArrayBuffer>> {
  const key = `${source}:${String(width)}x${String(height)}`;
  let bytes = drawn.get(key);
  if (!bytes) {
    bytes = draw(source, width, height);
    drawn.set(key, bytes);
  }
  return bytes;
}
