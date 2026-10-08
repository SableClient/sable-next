// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest';

import { isHeic, jpegFromHeic } from './heic-to-jpeg';

const heicTo = vi.hoisted(() => vi.fn());
vi.mock('heic-to/csp', () => ({ heicTo }));

const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));

const ftyp = (brand: string) =>
  new File(
    [new Uint8Array([0, 0, 0, 24, ...ascii('ftyp'), ...ascii(brand), 0, 0, 0, 0])],
    'shot.png'
  );

describe('isHeic', () => {
  it('reads the brand, not the name or the type', async () => {
    expect(await isHeic(ftyp('heic'))).toBe(true);
    expect(await isHeic(ftyp('mif1'))).toBe(true);
    expect(await isHeic(ftyp('avif'))).toBe(false);
    expect(await isHeic(new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], 'a.heic'))).toBe(
      false
    );
  });
});

describe('jpegFromHeic', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    heicTo.mockReset();
  });

  function stubCanvas(): void {
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
      drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
      callback(new Blob([new Uint8Array([0xff, 0xd8])], { type: 'image/jpeg' }));
    });
  }

  it('re-encodes a heic as a jpeg named after it', async () => {
    const close = vi.fn();
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.resolve({ width: 4, height: 3, close }))
    );
    stubCanvas();

    const out = await jpegFromHeic(ftyp('heic'));

    expect(out.type).toBe('image/jpeg');
    expect(out.name).toBe('shot.jpg');
    expect(close).toHaveBeenCalled();
    expect(heicTo).not.toHaveBeenCalled();
  });

  it('leaves anything else alone', async () => {
    const avif = ftyp('avif');
    expect(await jpegFromHeic(avif)).toBe(avif);
  });

  it('falls back to libheif when the engine cannot decode it', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.reject(new Error('unsupported')))
    );
    heicTo.mockResolvedValue({ width: 4, height: 3, close: vi.fn() });
    stubCanvas();

    const out = await jpegFromHeic(ftyp('heic'));

    expect(heicTo).toHaveBeenCalledWith(expect.objectContaining({ type: 'bitmap' }));
    expect(out.type).toBe('image/jpeg');
  });

  it('keeps the original when neither can decode it', async () => {
    vi.stubGlobal(
      'createImageBitmap',
      vi.fn(() => Promise.reject(new Error('unsupported')))
    );
    heicTo.mockRejectedValue(new Error('corrupt'));
    const heic = ftyp('heic');
    expect(await jpegFromHeic(heic)).toBe(heic);
  });
});
