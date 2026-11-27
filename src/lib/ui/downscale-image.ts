/** `always` re-encodes a picture that already fits, which drops its metadata. */
export async function downscaledImage(file: Blob, edge: number, always = false): Promise<Blob> {
  if (typeof createImageBitmap !== 'function') return file;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    try {
      const scale = Math.min(1, edge / Math.max(bitmap.width, bitmap.height));
      if (scale === 1 && !always) return file;
      const canvas = document.createElement('canvas');
      canvas.width = Math.max(1, Math.round(bitmap.width * scale));
      canvas.height = Math.max(1, Math.round(bitmap.height * scale));
      canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      return await new Promise<Blob>((resolve) => {
        canvas.toBlob(
          (blob) => {
            resolve(blob ?? file);
          },
          'image/webp',
          0.9
        );
      });
    } finally {
      bitmap.close();
    }
  } catch {
    return file;
  }
}
