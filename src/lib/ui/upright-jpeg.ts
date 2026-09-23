const EXIF_SCAN_BYTES = 65_536;
const ORIENTATION_TAG = 0x0112;

export function jpegOrientation(bytes: Uint8Array): number {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  try {
    if (view.getUint16(0) !== 0xffd8) return 1;
    let offset = 2;
    while (offset + 4 <= view.byteLength) {
      const marker = view.getUint16(offset);
      if (marker === 0xffda || (marker & 0xff00) !== 0xff00) return 1;
      const length = view.getUint16(offset + 2);
      if (marker === 0xffe1 && view.getUint32(offset + 4) === 0x45786966) {
        return exifOrientation(view, offset + 10);
      }
      offset += 2 + length;
    }
  } catch {
    return 1;
  }
  return 1;
}

function exifOrientation(view: DataView, tiff: number): number {
  const little = view.getUint16(tiff) === 0x4949;
  if (view.getUint16(tiff + 2, little) !== 42) return 1;
  const ifd = tiff + view.getUint32(tiff + 4, little);
  const entries = view.getUint16(ifd, little);
  for (let index = 0; index < entries; index += 1) {
    const entry = ifd + 2 + index * 12;
    if (view.getUint16(entry, little) === ORIENTATION_TAG) {
      return view.getUint16(entry + 8, little);
    }
  }
  return 1;
}

export async function uprightJpeg(file: Blob): Promise<Blob> {
  if (file.type !== 'image/jpeg' || typeof createImageBitmap !== 'function') return file;
  const head = new Uint8Array(await file.slice(0, EXIF_SCAN_BYTES).arrayBuffer());
  if (jpegOrientation(head) === 1) return file;

  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    try {
      const canvas = document.createElement('canvas');
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext('2d');
      if (!context) return file;
      context.drawImage(bitmap, 0, 0);
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, 'image/jpeg', 0.92);
      });
      return blob ?? file;
    } finally {
      bitmap.close();
    }
  } catch (error) {
    console.debug('[sable media] the jpeg could not be re-encoded upright', error);
    return file;
  }
}
