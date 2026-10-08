import { describe, expect, it } from 'vitest';

import { stripBytes, stripMetadata } from './strip-metadata';

const ascii = (text: string) => Array.from(text, (char) => char.charCodeAt(0));

const hex = (text: string) => text.split(/\s+/).map((byte) => parseInt(byte, 16));

function jpeg(orientation: number | null): Uint8Array<ArrayBuffer> {
  const exif =
    orientation === null
      ? []
      : [
          ...hex('ff e1 00 22'),
          ...ascii('Exif'),
          ...hex('00 00'),
          ...ascii('II'),
          ...hex('2a 00 08 00 00 00 01 00 12 01 03 00 01 00 00 00'),
          orientation,
          ...hex('00 00 00 00 00 00 00'),
        ];
  const comment = hex('ff fe 00 04 68 69');
  const icc = hex('ff e2 00 04 01 02');
  const scan = hex('ff da 01 02 03 ff d9');
  return new Uint8Array([0xff, 0xd8, ...exif, ...comment, ...icc, ...scan]);
}

function strip(
  bytes: Uint8Array<ArrayBuffer>,
  scope: 'location' | 'all' = 'all'
): Uint8Array<ArrayBuffer> {
  const out = stripBytes(bytes, scope);
  if (!out) throw new Error('not stripped');
  return out;
}

const find = (bytes: Uint8Array, marker: number) =>
  bytes.some((byte, index) => byte === 0xff && bytes[index + 1] === marker);

function pngChunk(type: string, data: number[]): number[] {
  return [0, 0, 0, data.length, ...ascii(type), ...data, 0, 0, 0, 0];
}

describe('stripBytes', () => {
  it('drops JPEG Exif, XMP and comments but keeps the ICC profile', () => {
    const out = strip(jpeg(1));
    expect(find(out, 0xe1)).toBe(false);
    expect(find(out, 0xfe)).toBe(false);
    expect(find(out, 0xe2)).toBe(true);
    expect([...out.slice(-2)]).toEqual([0xff, 0xd9]);
  });

  it('keeps only the orientation of a rotated JPEG', () => {
    const out = strip(jpeg(6));
    expect(find(out, 0xe1)).toBe(true);
    expect(out[out.indexOf(0x12) + 8]).toBe(6);
  });

  it('drops text and Exif chunks from a PNG', () => {
    const png = new Uint8Array([
      ...hex('89 50 4e 47 0d 0a 1a 0a'),
      ...pngChunk(
        'IHDR',
        Array.from({ length: 13 }, () => 0)
      ),
      ...pngChunk('eXIf', [1, 2, 3]),
      ...pngChunk('tEXt', [65, 0, 66]),
      ...pngChunk('IEND', []),
    ]);
    const out = strip(png);
    const text = String.fromCharCode(...out);
    expect(text).toContain('IHDR');
    expect(text).toContain('IEND');
    expect(text).not.toContain('eXIf');
    expect(text).not.toContain('tEXt');
  });

  it('drops EXIF and XMP from a WebP and fixes the sizes', () => {
    const chunk = (type: string, data: number[]) => [
      ...ascii(type),
      data.length,
      0,
      0,
      0,
      ...data,
      ...(data.length % 2 ? [0] : []),
    ];
    const body = [
      ...ascii('WEBP'),
      ...chunk('VP8X', [0x0c, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
      ...chunk('EXIF', [1, 2, 3]),
      ...chunk('XMP ', [4, 5]),
      ...chunk('VP8 ', [9, 9, 9, 9]),
    ];
    const webp = new Uint8Array([...ascii('RIFF'), body.length, 0, 0, 0, ...body]);
    const out = strip(webp);
    const text = String.fromCharCode(...out);
    expect(text).not.toContain('EXIF');
    expect(text).not.toContain('XMP ');
    expect(out[20]).toBe(0);
    expect(new DataView(out.buffer).getUint32(4, true)).toBe(out.length - 8);
  });

  it('keeps only the orientation of a rotated PNG', () => {
    const tiff = [
      ...hex('4d 4d 00 2a 00 00 00 08 00 01 01 12 00 03 00 00 00 01 00 06 00 00'),
      0,
      0,
      0,
      0,
    ];
    const png = new Uint8Array([
      ...hex('89 50 4e 47 0d 0a 1a 0a'),
      ...pngChunk('eXIf', [...tiff, ...ascii('GPS-SECRET')]),
      ...pngChunk('IEND', []),
    ]);
    const out = strip(png);
    const text = String.fromCharCode(...out);
    expect(text).toContain('eXIf');
    expect(text).not.toContain('GPS-SECRET');
    expect(out[out.indexOf(0x12) + 8]).toBe(6);
  });

  it('keeps only the orientation of a rotated WebP and flags it', () => {
    const tiff = [
      ...hex('49 49 2a 00 08 00 00 00 01 00 12 01 03 00 01 00 00 00 06 00 00 00'),
      0,
      0,
      0,
      0,
    ];
    const body = [
      ...ascii('WEBP'),
      ...ascii('VP8X'),
      10,
      0,
      0,
      0,
      0x0c,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      0,
      ...ascii('VP8 '),
      4,
      0,
      0,
      0,
      9,
      9,
      9,
      9,
      ...ascii('EXIF'),
      tiff.length,
      0,
      0,
      0,
      ...tiff,
    ];
    const webp = new Uint8Array([...ascii('RIFF'), body.length, 0, 0, 0, ...body]);
    const out = strip(webp);
    expect(String.fromCharCode(...out)).toContain('EXIF');
    expect(out[20]).toBe(0x08);
    expect(out[out.indexOf(0x12) + 8]).toBe(6);
    expect(new DataView(out.buffer).getUint32(4, true)).toBe(out.length - 8);
  });

  it('zeroes the Exif and XMP items of a HEIC in place', () => {
    const box = (type: string, ...body: number[][]) => {
      const content = body.flat();
      return [0, 0, 0, content.length + 8, ...ascii(type), ...content];
    };
    const infe = (id: number, type: string, extra: number[] = []) =>
      box('infe', [2, 0, 0, 0], [0, id], [0, 0], ascii(type), [0], extra);
    const u32 = (value: number) => [
      value >>> 24,
      (value >>> 16) & 0xff,
      (value >>> 8) & 0xff,
      value & 0xff,
    ];
    const payload = [...ascii('SECRET-EXIF'), ...ascii('SECRET-XMP')];
    const iloc = (exifAt: number, xmpAt: number) =>
      box(
        'iloc',
        [0, 0, 0, 0],
        [0x44, 0x00],
        [0, 2],
        [0, 1, 0, 0, 0, 1, ...u32(exifAt), ...u32(11)],
        [0, 2, 0, 0, 0, 1, ...u32(xmpAt), ...u32(10)]
      );
    const meta = (exifAt: number, xmpAt: number) =>
      box(
        'meta',
        [0, 0, 0, 0],
        box(
          'iinf',
          [0, 0, 0, 0],
          [0, 2],
          infe(1, 'Exif'),
          infe(2, 'mime', [...ascii('application/rdf+xml'), 0])
        ),
        iloc(exifAt, xmpAt)
      );
    const head = [...box('ftyp', ascii('heic'), [0, 0, 0, 0])];
    const dataAt = head.length + meta(0, 0).length + 8;
    const file = new Uint8Array([...head, ...meta(dataAt, dataAt + 11), ...box('mdat', payload)]);

    const out = strip(file);
    const text = String.fromCharCode(...out);
    expect(text).not.toContain('SECRET');
    expect(out.length).toBe(file.length);
    expect(text).toContain('ftyp');
  });

  it('leaves unknown formats and truncated files alone', () => {
    expect(stripBytes(new Uint8Array([1, 2, 3, 4]), 'all')).toBeNull();
    expect(stripBytes(new Uint8Array([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]), 'all')).toBeNull();
  });
});

function geoTiff(): Uint8Array<ArrayBuffer> {
  const tiff = new Uint8Array(86);
  const view = new DataView(tiff.buffer);
  tiff.set(ascii('MM'));
  view.setUint16(2, 0x2a);
  view.setUint32(4, 8);
  view.setUint16(8, 2);
  view.setUint16(10, 0x010f);
  view.setUint16(12, 2);
  view.setUint32(14, 6);
  view.setUint32(18, 38);
  view.setUint16(22, 0x8825);
  view.setUint16(24, 4);
  view.setUint32(26, 1);
  view.setUint32(30, 44);
  tiff.set(ascii('Canon'), 38);
  view.setUint16(44, 1);
  view.setUint16(46, 2);
  view.setUint16(48, 5);
  view.setUint32(50, 3);
  view.setUint32(54, 62);
  tiff.fill(0x5a, 62, 86);
  return tiff;
}

describe('location scope', () => {
  const jpegWithGps = () => {
    const tiff = geoTiff();
    const length = tiff.length + 8;
    return new Uint8Array([
      ...hex('ff d8 ff e1'),
      length >> 8,
      length & 0xff,
      ...ascii('Exif'),
      0,
      0,
      ...tiff,
      ...hex('ff da 01 02 ff d9'),
    ]);
  };

  it('clears the GPS data of a JPEG and keeps the camera make', () => {
    const out = strip(jpegWithGps(), 'location');
    const text = String.fromCharCode(...out);
    expect(text).toContain('Canon');
    expect(out).not.toContain(0x5a);
    expect(out.length).toBe(jpegWithGps().length);
  });

  it('clears the GPS data of a PNG and keeps its checksum valid', () => {
    const png = new Uint8Array([
      ...hex('89 50 4e 47 0d 0a 1a 0a'),
      ...pngChunk('eXIf', [...geoTiff()]),
      ...pngChunk('IEND', []),
    ]);
    const out = strip(png, 'location');
    expect(String.fromCharCode(...out)).toContain('Canon');
    expect(out).not.toContain(0x5a);
    expect(out.slice(-12 - 4, -12)).not.toEqual(png.slice(-12 - 4, -12));
  });

  it('drops an XMP packet that names a location and keeps one that does not', () => {
    const xmp = (text: string) => {
      const body = [...ascii('http://ns.adobe.com/xap/1.0/'), 0, ...ascii(text)];
      return [0xff, 0xe1, (body.length + 2) >> 8, (body.length + 2) & 0xff, ...body];
    };
    const tail = hex('ff da 01 02 ff d9');
    const withGps = new Uint8Array([0xff, 0xd8, ...xmp('exif:GPSLatitude'), ...tail]);
    const without = new Uint8Array([0xff, 0xd8, ...xmp('dc:title'), ...tail]);
    expect(strip(withGps, 'location').length).toBe(withGps.length - xmp('exif:GPSLatitude').length);
    expect(strip(without, 'location').length).toBe(without.length);
  });
});

describe('stripMetadata', () => {
  it('leaves the file alone when metadata is kept', async () => {
    const file = new File([jpeg(1)], 'a.jpg', { type: 'image/jpeg' });
    expect(await stripMetadata(file, 'keep')).toBe(file);
  });

  it('returns a smaller file with the same name and type', async () => {
    const file = new File([jpeg(null)], 'a.jpg', { type: 'image/jpeg' });
    const out = await stripMetadata(file, 'all');
    expect(out.name).toBe('a.jpg');
    expect(out.type).toBe('image/jpeg');
    expect(out.size).toBeLessThan(file.size);
  });

  it('returns the original when nothing can be stripped', async () => {
    const file = new File(['plain'], 'a.txt', { type: 'text/plain' });
    expect(await stripMetadata(file, 'all')).toBe(file);
  });
});
