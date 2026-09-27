import type { RoomAttachmentKind, RoomAttachmentView } from '#src/generated/protocol';

import type { CoreClient } from '#lib/core/client.svelte.js';

import { galleryItemId } from './media-items.js';

const PAGE_SIZE = 30;

function attachmentKey(item: RoomAttachmentView): string {
  return item.gallery_index === null
    ? item.event_id
    : galleryItemId(item.event_id, item.gallery_index);
}

export class RoomAttachmentsPager {
  kind = $state<RoomAttachmentKind>('media');
  items = $state.raw<RoomAttachmentView[]>([]);
  loading = $state(true);
  failed = $state(false);
  exhausted = $state(false);

  #roomId: string | null = null;
  #cursor: string | null = null;
  #generation = 0;

  constructor(private readonly core: CoreClient) {}

  sync(roomId: string): void {
    if (this.#roomId === roomId) return;
    this.#roomId = roomId;
    this.#reset();
  }

  select(kind: RoomAttachmentKind): void {
    if (this.kind === kind) return;
    this.kind = kind;
    this.#reset();
  }

  loadMore(): void {
    if (this.loading || this.failed || this.exhausted) return;
    void this.#load();
  }

  retry(): void {
    if (this.#roomId === null || this.loading) return;
    void this.#load();
  }

  dispose(): void {
    this.#generation += 1;
    this.#roomId = null;
  }

  #reset(): void {
    this.#generation += 1;
    this.items = [];
    this.#cursor = null;
    this.exhausted = false;
    void this.#load();
  }

  async #load(): Promise<void> {
    const roomId = this.#roomId;
    if (roomId === null) return;
    const generation = this.#generation;
    const cursor = this.#cursor;
    const kind = this.kind;
    this.loading = true;
    this.failed = false;
    try {
      const page = await this.core.commands.roomAttachments(roomId, kind, PAGE_SIZE, cursor);
      if (generation !== this.#generation) return;
      this.items = cursor === null ? page.items : [...this.items, ...this.#unseen(page.items)];
      this.#cursor = page.next_batch;
      this.exhausted = page.next_batch === null;
    } catch (error) {
      console.debug('[sable room] attachments unavailable', error);
      if (generation === this.#generation) this.failed = true;
    } finally {
      if (generation === this.#generation) this.loading = false;
    }
  }

  #unseen(page: readonly RoomAttachmentView[]): RoomAttachmentView[] {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a local lookup, never observed
    const loaded = new Set(this.items.map(attachmentKey));
    return page.filter((item) => !loaded.has(attachmentKey(item)));
  }
}
