import { vi } from 'vitest';

export const STILL = 'blob:still';

export function mockStillFrames(objectUrl: (object: Blob | MediaSource) => string): void {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockReturnValue({
    drawImage: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation((callback) => {
    callback(new Blob([], { type: 'image/webp' }));
  });
  vi.spyOn(URL, 'createObjectURL').mockImplementation((object) =>
    object instanceof Blob && object.type === 'image/webp' ? STILL : objectUrl(object)
  );
}
