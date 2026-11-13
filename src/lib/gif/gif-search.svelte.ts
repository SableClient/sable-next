import { embedServiceUrl } from '#lib/config/embed-service.js';

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

  search(serviceUrl: string, provider: GifProvider, apiKey: string, query: string): void {
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
      void this.#run(serviceUrl, provider, apiKey, term, generation);
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
    serviceUrl: string,
    provider: GifProvider,
    apiKey: string,
    term: string,
    generation: number
  ): Promise<void> {
    const controller = new AbortController();
    this.#controller = controller;

    try {
      const response = await fetch(
        embedServiceUrl(serviceUrl, 'gifs/search', { provider: provider.id, key: apiKey, q: term }),
        { signal: controller.signal }
      );
      if (!response.ok) throw new Error(`HTTP ${String(response.status)}`);
      const parsed = provider.parse(await response.json());
      if (generation !== this.#generation) return;
      this.results = parsed.filter(
        (gif, index) =>
          gif.mediaUrl !== '' &&
          parsed.findIndex(({ mediaUrl }) => mediaUrl === gif.mediaUrl) === index
      );
      this.failed = false;
    } catch (error) {
      if (generation !== this.#generation) return;
      console.warn('[sable gif] searching gifs failed', error);
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
