import type { GifProvider, GifResult } from './providers';

/* Generation-guarded: a late response for a superseded query is discarded. */
export class GifSearch {
  results = $state.raw<GifResult[]>([]);
  loading = $state(false);
  failed = $state(false);

  #generation = 0;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #controller: AbortController | undefined;
  #wait: number;

  constructor(wait = 200) {
    this.#wait = wait;
  }

  search(provider: GifProvider, apiKey: string, query: string): void {
    this.cancel();
    const term = query.trim();
    if (term === '') {
      this.results = [];
      return;
    }

    this.loading = true;
    this.failed = false;
    const generation = this.#generation;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      void this.#run(provider, apiKey, term, generation);
    }, this.#wait);
  }

  cancel(): void {
    this.#generation += 1;
    clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#controller?.abort();
    this.#controller = undefined;
    this.loading = false;
  }

  reset(): void {
    this.cancel();
    this.results = [];
    this.failed = false;
  }

  async #run(
    provider: GifProvider,
    apiKey: string,
    term: string,
    generation: number
  ): Promise<void> {
    const controller = new AbortController();
    this.#controller = controller;

    try {
      const response = await fetch(provider.searchUrl(apiKey, term), {
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      const parsed = provider.parse(await response.json());
      if (generation !== this.#generation) return;
      this.results = parsed.filter((gif) => gif.mediaUrl !== '');
      this.failed = false;
    } catch {
      if (generation !== this.#generation) return;
      this.results = [];
      this.failed = true;
    } finally {
      if (generation === this.#generation) {
        this.#controller = undefined;
        this.loading = false;
      }
    }
  }
}
