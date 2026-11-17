import type { RoomAttachmentKind } from '#src/generated/protocol';

import type { CoreClient } from '#lib/core/client.svelte.js';

import { attachmentKey, isAttachmentOf, type RoomAttachmentOf } from './room-attachments';

const PAGE_SIZE = 30;

export class RoomAttachmentsPager<K extends RoomAttachmentKind> {
  items = $state.raw<RoomAttachmentOf<K>[]>([]);
  loading = $state(true);
  failed = $state(false);
  exhausted = $state(false);

  #roomId: string | null = null;
  #cursor: string | null = null;
  #generation = 0;

  constructor(
    private readonly core: CoreClient,
    readonly kind: K
  ) {}

  sync(roomId: string): void {
    if (this.#roomId === roomId) return;
    this.#roomId = roomId;
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
      const page = await this.core.rpc.rooms.attachments({
        room_id: roomId,
        kind,
        limit: PAGE_SIZE,
        from: cursor,
      });
      if (generation !== this.#generation) return;
      const items = page.items.filter((item) => isAttachmentOf(kind, item));
      this.items = cursor === null ? items : [...this.items, ...this.#unseen(items)];
      this.#cursor = page.next_batch;
      this.exhausted = page.next_batch === null;
    } catch (error) {
      console.debug('[sable room] attachments unavailable', error);
      if (generation === this.#generation) this.failed = true;
    } finally {
      if (generation === this.#generation) this.loading = false;
    }
  }

  #unseen(page: readonly RoomAttachmentOf<K>[]): RoomAttachmentOf<K>[] {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- a local lookup, never observed
    const loaded = new Set(this.items.map(attachmentKey));
    return page.filter((item) => !loaded.has(attachmentKey(item)));
  }
}
