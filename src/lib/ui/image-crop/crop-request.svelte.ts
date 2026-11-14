import { isCroppable } from './croppable.js';

export type CropPreset = 'avatar' | 'banner' | 'attachment';

interface Pending {
  file: File;
  preset: CropPreset;
  resolve: (file: File | null) => void;
}

class CropRequest {
  current = $state.raw<Pending | null>(null);
  hosts = 0;

  settle(file: File | null): void {
    const pending = this.current;
    this.current = null;
    pending?.resolve(file);
  }
}

export const cropRequest = new CropRequest();

export function holdCropHost(): () => void {
  cropRequest.hosts += 1;
  return () => {
    cropRequest.hosts -= 1;
    cropRequest.settle(null);
  };
}

/** Resolves the cropped file, the original when kept or not croppable, or null on cancel. */
export async function requestCrop(file: File, preset: CropPreset): Promise<File | null> {
  if (cropRequest.hosts === 0 || !(await isCroppable(file))) return file;
  cropRequest.settle(null);
  return new Promise((resolve) => {
    cropRequest.current = { file, preset, resolve };
  });
}
