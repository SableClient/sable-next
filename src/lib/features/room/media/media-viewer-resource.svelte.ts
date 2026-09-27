import type { CoreClient } from '#lib/core/client.svelte.js';
import { cachedMediaUrl, holdMediaUrl, loadMediaUrl } from '#lib/ui/media-url.js';
import { videoStreamUrl } from '#lib/ui/video-stream.svelte.js';

export class MediaViewerResource {
  url = $state<string | null>(null);
  failed = $state(false);
  streamUnavailable = $state(false);

  #generation = 0;
  #release: (() => void) | null = null;
  #streamUrl: string | null = null;
  #source: string | null = null;

  constructor(
    private readonly core: CoreClient,
    private readonly currentTime: () => number
  ) {}

  load(source: string | null, mime: string | null, transcode: boolean): () => void {
    this.#releaseCurrent();
    const generation = ++this.#generation;
    if (source !== this.#source) this.streamUnavailable = false;
    this.#source = source;
    this.url = null;
    this.failed = false;
    if (source === null) return () => {};

    if (transcode) {
      void videoStreamUrl(this.core, source, this.currentTime, (next) => {
        if (generation === this.#generation) this.url = next;
      })
        .then((next) => {
          if (generation !== this.#generation) {
            URL.revokeObjectURL(next);
            return;
          }
          this.#adoptStream(next);
          this.url = next;
        })
        .catch(() => {
          if (generation === this.#generation) this.streamUnavailable = true;
        });
    } else {
      const release = holdMediaUrl(this.core, source, 0, 0);
      this.#release = release;
      const cached = cachedMediaUrl(this.core, source, 0, 0);
      this.url = cached ?? null;
      void (cached ? Promise.resolve(cached) : loadMediaUrl(this.core, source, 0, 0, mime))
        .then((url) => {
          if (generation === this.#generation) this.url = url;
        })
        .catch(() => {
          if (generation === this.#generation) this.failed = true;
        });
    }

    return () => {
      if (generation !== this.#generation) return;
      this.#generation += 1;
      this.#releaseCurrent();
    };
  }

  dispose(): void {
    this.#generation += 1;
    this.#releaseCurrent();
  }

  #adoptStream(next: string): void {
    if (this.#streamUrl !== null && this.#streamUrl !== next) URL.revokeObjectURL(this.#streamUrl);
    this.#streamUrl = next;
  }

  #releaseCurrent(): void {
    this.#release?.();
    this.#release = null;
    if (this.#streamUrl !== null) URL.revokeObjectURL(this.#streamUrl);
    this.#streamUrl = null;
  }
}
