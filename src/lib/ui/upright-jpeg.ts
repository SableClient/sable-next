const EXIF_SCAN_BYTES = 65_536;
export async function jpegOrientation(bytes: Uint8Array): Promise<number> {
  try {
    const { load } = await import('exifreader');
    const orientation = load(bytes).Orientation?.value;
    return typeof orientation === 'number' ? orientation : 1;
  } catch {
    return 1;
  }
}

export async function uprightJpeg(file: Blob): Promise<Blob> {
  if (file.type !== 'image/jpeg' || typeof createImageBitmap !== 'function') return file;
  const head = new Uint8Array(await file.slice(0, EXIF_SCAN_BYTES).arrayBuffer());
  if ((await jpegOrientation(head)) === 1) return file;

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

export async function uprightImageBytes(
  file: Blob
): Promise<{ mime: string; bytes: Uint8Array<ArrayBuffer> }> {
  const upright = await uprightJpeg(file);
  return { mime: upright.type || 'image/*', bytes: new Uint8Array(await upright.arrayBuffer()) };
}
