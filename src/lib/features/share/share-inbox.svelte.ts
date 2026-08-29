import type { SharedBatch } from '#lib/platform/share-target.js';
import {
  clearSharedBatch,
  drainSharedContent,
  readSharedFile,
  receivesSharedContent,
  subscribeSharedContent,
} from '#lib/platform/share-target.js';
import { subscribeDeepLinks } from '#lib/platform/deep-links.js';

import {
  collectShareFiles,
  collectShareText,
  displayFileName,
  isShareDeepLink,
  mergeShareBatches,
} from './share-content.js';

export class ShareInbox {
  #batches = $state.raw<SharedBatch[]>([]);
  #webText = $state('');
  #webFiles = $state.raw<File[]>([]);

  // eslint-disable-next-line svelte/prefer-svelte-reactivity -- nothing renders from it
  readonly #spent = new Set<string>();

  get pending(): boolean {
    return this.#batches.length > 0 || this.#webText !== '' || this.#webFiles.length > 0;
  }

  get text(): string {
    const native = collectShareText(this.#batches);
    return [native, this.#webText].filter((part) => part !== '').join('\n');
  }

  get fileCount(): number {
    return collectShareFiles(this.#batches).length + this.#webFiles.length;
  }

  async drain(): Promise<void> {
    const batches = (await drainSharedContent()).filter((batch) => !this.#spent.has(batch.batchId));
    if (batches.length === 0) return;
    this.#batches = mergeShareBatches(this.#batches, batches);
  }

  accept(text: string, files: readonly File[]): void {
    this.#webText = [this.#webText, text].filter((part) => part !== '').join('\n');
    this.#webFiles = [...this.#webFiles, ...files];
  }

  async files(): Promise<File[]> {
    const refs = collectShareFiles(this.#batches);
    const read = await Promise.all(
      refs.map(async (ref) => {
        const bytes = await readSharedFile(ref.batchId, ref.fileName);
        return new File([bytes as BlobPart], displayFileName(ref.fileName), {
          type: ref.mime ?? 'application/octet-stream',
        });
      })
    );
    return [...read, ...this.#webFiles];
  }

  async clear(): Promise<void> {
    const ids = this.#batches.map((batch) => batch.batchId);
    for (const id of ids) this.#spent.add(id);
    this.#batches = [];
    this.#webText = '';
    this.#webFiles = [];

    await Promise.all(
      ids.map((id) =>
        clearSharedBatch(id).catch((error: unknown) => {
          console.debug('[sable share-target] clearing failed', error);
        })
      )
    );
  }
}

export function watchSharedContent(inbox: ShareInbox): () => void {
  const drain = (): void => {
    void inbox.drain().catch((error: unknown) => {
      console.debug('[sable share-target] draining failed', error);
    });
  };

  drain();
  if (!receivesSharedContent()) return () => {};

  let stopped = false;
  const stops: (() => void)[] = [];

  const collect = (stop: () => void): void => {
    if (stopped) stop();
    else stops.push(stop);
  };

  void subscribeSharedContent(drain).then(collect, () => undefined);
  void subscribeDeepLinks((urls) => {
    if (urls.some(isShareDeepLink)) drain();
  }).then(collect, () => undefined);

  const onVisible = (): void => {
    if (document.visibilityState === 'visible') drain();
  };
  document.addEventListener('visibilitychange', onVisible);

  return () => {
    stopped = true;
    for (const stop of stops) stop();
    document.removeEventListener('visibilitychange', onVisible);
  };
}
