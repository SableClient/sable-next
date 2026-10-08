import {
  saveFile,
  saveImageToPhotos,
  savesNatively,
  shareFile,
  type SaveOutcome,
} from '#lib/platform/files.js';
import { toasts } from '#lib/ui/toasts.svelte.js';

import type { MediaItem } from './media-viewer-types';

interface MediaTarget {
  url: string | null;
  item: MediaItem | undefined;
  fileName: string;
}

interface MediaActionMessages {
  copied: string;
  copyFailed: string;
  saved: string;
  saveFailed: string;
}

export class MediaViewerActions {
  constructor(
    private readonly target: () => MediaTarget,
    private readonly messages: () => MediaActionMessages
  ) {}

  async share(anchor: HTMLElement, nativeShare: boolean): Promise<void> {
    const { url, item, fileName } = this.target();
    if (!url || !item) return;
    const name = fileName || 'image';
    if (nativeShare) {
      await shareFile(url, name, item.mime ?? undefined, anchor.getBoundingClientRect());
      return;
    }
    try {
      const blob = await (await fetch(url)).blob();
      const file = new File([blob], name, {
        type: blob.type || item.mime || 'application/octet-stream',
      });
      if ('canShare' in navigator && navigator.canShare({ files: [file] })) {
        await navigator.share({ files: [file], title: name });
        return;
      }
      await navigator.share({ title: name, text: name });
    } catch (error) {
      console.debug('[sable viewer] share dismissed', error);
    }
  }

  async copyImage(): Promise<void> {
    const { url } = this.target();
    if (!url) return;
    try {
      const png = this.#pngBlob(await (await fetch(url)).blob());
      await navigator.clipboard.write([new ClipboardItem({ 'image/png': png })]);
      toasts.info(this.messages().copied);
    } catch (error) {
      console.debug('[sable viewer] copy failed', error);
      toasts.error(this.messages().copyFailed);
    }
  }

  async download(): Promise<void> {
    const { url, item, fileName } = this.target();
    if (!url || !item) return;
    const name = fileName || 'image';
    if (savesNatively()) {
      this.#reportSave(await saveFile(url, name));
      return;
    }
    const anchor = document.createElement('a');
    anchor.href = url;
    anchor.download = name;
    anchor.click();
  }

  async saveToPhotos(): Promise<void> {
    const { url, item, fileName } = this.target();
    if (!url || !item) return;
    this.#reportSave(await saveImageToPhotos(url, fileName || 'image', item.mime ?? undefined));
  }

  async #pngBlob(blob: Blob): Promise<Blob> {
    if (blob.type === 'image/png') return blob;
    const bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    bitmap.close();
    return new Promise((resolve, reject) => {
      canvas.toBlob((png) => {
        if (png) resolve(png);
        else reject(new Error('encode failed'));
      }, 'image/png');
    });
  }

  #reportSave(outcome: SaveOutcome): void {
    if (outcome === 'saved') toasts.info(this.messages().saved);
    if (outcome === 'failed') toasts.error(this.messages().saveFailed);
  }
}
