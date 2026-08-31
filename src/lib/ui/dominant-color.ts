const SAMPLE_SIZE = 32;
const BUCKETS = 4096;
const MIN_ALPHA = 16;
const DARKEN = 0.8;

function bucketPixels(data: Uint8ClampedArray): {
  counts: Uint16Array;
  totals: Uint32Array;
} {
  const counts = new Uint16Array(BUCKETS);
  const totals = new Uint32Array(BUCKETS * 3);

  for (let index = 0; index < data.length; index += 4) {
    if (data[index + 3] < MIN_ALPHA) continue;
    const key =
      Math.trunc(data[index] / 16) * 256 +
      Math.trunc(data[index + 1] / 16) * 16 +
      Math.trunc(data[index + 2] / 16);
    const slot = key * 3;
    counts[key] += 1;
    totals[slot] += data[index];
    totals[slot + 1] += data[index + 1];
    totals[slot + 2] += data[index + 2];
  }

  return { counts, totals };
}

function bestBucket(counts: Uint16Array, totals: Uint32Array): number | null {
  let bestScore = -1;
  let best: number | null = null;

  for (let key = 0; key < BUCKETS; key += 1) {
    const count = counts[key];
    if (count === 0) continue;
    const slot = key * 3;
    const red = totals[slot] / count;
    const green = totals[slot + 1] / count;
    const blue = totals[slot + 2] / count;

    const chroma = (Math.max(red, green, blue) - Math.min(red, green, blue)) / 255;
    const luma = (red * 0.2126 + green * 0.7152 + blue * 0.0722) / 255;
    const midtone = Math.max(0.2, 1 - Math.abs(luma - 0.5) * 1.2);
    const score = count * (1 + chroma * 2) * midtone;

    if (score > bestScore) {
      bestScore = score;
      best = key;
    }
  }

  return best;
}

function darken(red: number, green: number, blue: number): string {
  const max = Math.max(red, green, blue) / 255;
  const min = Math.min(red, green, blue) / 255;
  const lightness = (max + min) / 2;
  const delta = max - min;
  const saturation = delta === 0 ? 0 : delta / (1 - Math.abs(2 * lightness - 1));

  let hue = 0;
  if (delta > 0) {
    const [rn, gn, bn] = [red / 255, green / 255, blue / 255];
    if (max === rn) hue = ((gn - bn) / delta) % 6;
    else if (max === gn) hue = (bn - rn) / delta + 2;
    else hue = (rn - gn) / delta + 4;
    hue = Math.round(hue * 60);
    if (hue < 0) hue += 360;
  }

  const scaled = lightness * DARKEN;
  const chroma = (1 - Math.abs(2 * scaled - 1)) * saturation;
  const second = chroma * (1 - Math.abs(((hue / 60) % 2) - 1));
  const base = scaled - chroma / 2;

  const sextants: readonly [number, number, number][] = [
    [chroma, second, 0],
    [second, chroma, 0],
    [0, chroma, second],
    [0, second, chroma],
    [second, 0, chroma],
    [chroma, 0, second],
  ];
  const [r, g, b] = sextants[Math.min(5, Math.trunc(hue / 60))];

  return `rgb(${Math.round((r + base) * 255)}, ${Math.round((g + base) * 255)}, ${Math.round(
    (b + base) * 255
  )})`;
}

export function plateColor(data: Uint8ClampedArray): string | null {
  const { counts, totals } = bucketPixels(data);
  const key = bestBucket(counts, totals);
  if (key === null) return null;

  return darken(
    Math.trunc(key / 256) * 16 + 8,
    (Math.trunc(key / 16) % 16) * 16 + 8,
    (key % 16) * 16 + 8
  );
}

export function dominantColor(image: HTMLImageElement): string | null {
  if (image.naturalWidth === 0 || image.naturalHeight === 0) return null;

  const canvas = document.createElement('canvas');
  canvas.width = SAMPLE_SIZE;
  canvas.height = SAMPLE_SIZE;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) return null;

  try {
    context.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
    return plateColor(context.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE).data);
  } catch {
    return null;
  }
}
