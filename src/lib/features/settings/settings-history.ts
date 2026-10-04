export interface SettingsVisit {
  type: string;
  delta?: number;
  fromPath: string | null;
}

export class SettingsHistory {
  depth = 0;
  #replacing = false;

  constructor(private readonly isSettingsPath: (path: string) => boolean) {}

  visit({ type, delta, fromPath }: SettingsVisit): void {
    if (type === 'popstate') {
      this.depth = Math.max(0, this.depth + (delta ?? 0));
    } else if (fromPath === null || type === 'enter') {
      this.depth = 0;
    } else if (!this.isSettingsPath(fromPath)) {
      this.depth = 1;
    } else if (this.#replacing) {
      this.#replacing = false;
    } else {
      this.depth += 1;
    }
  }

  replacing(): void {
    this.#replacing = true;
  }
}
