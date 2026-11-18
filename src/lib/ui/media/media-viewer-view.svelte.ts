import type { Vector2 } from '#lib/ui/pan-clamp.js';

export class MediaViewerView {
  zoom = $state(1);
  rotation = $state(0);
  pan = $state.raw<Vector2>({ x: 0, y: 0 });
  fitRatio = $state(1);
  fitsWindow = $state(true);
  imageReady = $state(false);
  editingZoom = $state(false);
  pdfPages = $state(0);
  pdfPage = $state(1);
  pixelated: boolean;

  constructor(pixelated: boolean) {
    this.pixelated = $state(pixelated);
  }
}
