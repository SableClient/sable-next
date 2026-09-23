import { expect, test } from 'vitest';

import { jpegOrientation, uprightJpeg } from './upright-jpeg.js';

function jpegWithOrientation(orientation: number, little: boolean): Uint8Array<ArrayBuffer> {
  const tiff = new DataView(new ArrayBuffer(26));
  tiff.setUint16(0, little ? 0x4949 : 0x4d4d);
  tiff.setUint16(2, 42, little);
  tiff.setUint32(4, 8, little);
  tiff.setUint16(8, 1, little);
  tiff.setUint16(10, 0x0112, little);
  tiff.setUint16(12, 3, little);
  tiff.setUint32(14, 1, little);
  tiff.setUint16(18, orientation, little);

  const app0 = [0xff, 0xe0, 0x00, 0x04, 0x00, 0x00];
  const exif = [0x45, 0x78, 0x69, 0x66, 0x00, 0x00, ...new Uint8Array(tiff.buffer)];
  const length = exif.length + 2;
  return new Uint8Array([
    0xff,
    0xd8,
    ...app0,
    0xff,
    0xe1,
    length >> 8,
    length & 0xff,
    ...exif,
    0xff,
    0xda,
  ]);
}

test('reads the orientation from big- and little-endian EXIF', () => {
  expect(jpegOrientation(jpegWithOrientation(6, false))).toBe(6);
  expect(jpegOrientation(jpegWithOrientation(8, true))).toBe(8);
});

test('treats a jpeg without EXIF, a non-jpeg and a truncated file as upright', () => {
  expect(jpegOrientation(new Uint8Array([0xff, 0xd8, 0xff, 0xda, 0x00, 0x02]))).toBe(1);
  expect(jpegOrientation(new Uint8Array([0x89, 0x50, 0x4e, 0x47]))).toBe(1);
  expect(jpegOrientation(jpegWithOrientation(6, false).slice(0, 20))).toBe(1);
});

test('leaves a non-jpeg and an upright jpeg untouched', async () => {
  const png = new Blob([new Uint8Array([0x89, 0x50])], { type: 'image/png' });
  const upright = new Blob([jpegWithOrientation(1, false)], { type: 'image/jpeg' });
  expect(await uprightJpeg(png)).toBe(png);
  expect(await uprightJpeg(upright)).toBe(upright);
});
