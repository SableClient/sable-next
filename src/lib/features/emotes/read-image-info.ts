import type { PackImageInfoView } from '#src/generated/PackImageInfoView';

export async function readImageInfo(file: File): Promise<PackImageInfoView | null> {
  const base: PackImageInfoView = {
    width: null,
    height: null,
    mimetype: file.type === '' ? null : file.type,
    size: file.size,
  };

  if (typeof createImageBitmap !== 'function') return base;

  try {
    const bitmap = await createImageBitmap(file);
    const info = { ...base, width: bitmap.width, height: bitmap.height };
    bitmap.close();
    return info;
  } catch (error) {
    console.debug('[sable emotes] the image dimensions could not be read', error);
    return base;
  }
}
