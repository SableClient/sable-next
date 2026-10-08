const HEIC_BRANDS = new Set(['heic', 'heix', 'heim', 'heis', 'hevc', 'hevx', 'mif1', 'msf1']);
const MAX_CANVAS_PIXELS = 16_777_216;

export async function isHeic(file: Blob): Promise<boolean> {
  const head = new Uint8Array(await file.slice(0, 12).arrayBuffer());
  const ascii = (offset: number) => String.fromCharCode(...head.subarray(offset, offset + 4));
  return head.length === 12 && ascii(4) === 'ftyp' && HEIC_BRANDS.has(ascii(8));
}

export async function jpegFromHeic(file: File): Promise<File> {
  if (!(await isHeic(file))) return file;
  try {
    const bitmap = await decode(file);
    try {
      const scale = Math.min(1, Math.sqrt(MAX_CANVAS_PIXELS / (bitmap.width * bitmap.height)));
      const canvas = document.createElement('canvas');
      canvas.width = Math.floor(bitmap.width * scale);
      canvas.height = Math.floor(bitmap.height * scale);
      const context = canvas.getContext('2d');
      if (!context) return file;
      context.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
      const blob = await new Promise<Blob | null>((resolve) => {
        canvas.toBlob(resolve, 'image/jpeg', 0.92);
      });
      if (!blob) return file;
      return new File([blob], `${file.name.replace(/\.[^.]*$/, '')}.jpg`, {
        type: 'image/jpeg',
        lastModified: file.lastModified,
      });
    } finally {
      bitmap.close();
    }
  } catch (error) {
    console.debug('[sable media] the heic could not be re-encoded as jpeg', error);
    return file;
  }
}

async function decode(file: File): Promise<ImageBitmap> {
  try {
    return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    const { heicTo } = await import('heic-to/csp');
    return heicTo({ blob: file, type: 'bitmap', options: { imageOrientation: 'from-image' } });
  }
}
