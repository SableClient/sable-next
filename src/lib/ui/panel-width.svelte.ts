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
    const stored = Number.parseFloat(localStorage.getItem(this.storageKey) ?? '');
    if (Number.isFinite(stored)) this.resize(stored);
  }

  resize(next: number): void {
    this.width = Math.max(this.min, Math.min(this.max, next));
  }

  commit(): void {
    localStorage.setItem(this.storageKey, String(this.width));
  }
}

export function remFromPixels(pixels: number): number {
  return pixels / Number.parseFloat(getComputedStyle(document.documentElement).fontSize);
}
