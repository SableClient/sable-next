import { clamp } from '#lib/clamp.js';
import { readText, writeText } from '#lib/platform/local-json.js';

export class PanelWidth {
  width = $state(0);

  constructor(
    private readonly storageKey: string,
    fallback: number,
    readonly min: number,
    readonly max: number
  ) {
    this.width = fallback;
  }

  restore(): void {
    const stored = Number.parseFloat(readText(this.storageKey) ?? '');
    if (Number.isFinite(stored)) this.resize(stored);
  }

  resize(next: number): void {
    this.width = clamp(next, this.min, this.max);
  }

  commit(): void {
    writeText(this.storageKey, String(this.width));
  }
}

export function remFromPixels(pixels: number): number {
  return pixels / Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
}
