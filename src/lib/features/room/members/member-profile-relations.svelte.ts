import type { MutualRoomView } from '#src/generated/protocol';

import type { CoreClient } from '#lib/core/client.svelte.js';

export class MemberProfileRelations {
  rooms = $state.raw<MutualRoomView[]>([]);
  ignored = $state(false);

  #userId: string | null = null;
  #self = false;
  #generation = 0;

  constructor(private readonly core: CoreClient) {}

  sync(userId: string, self: boolean): void {
    if (this.#userId === userId && this.#self === self) return;
    this.#userId = userId;
    this.#self = self;
    const generation = ++this.#generation;
    this.rooms = [];
    this.ignored = false;
    if (self) return;
    void this.core.userRelations(userId).then(
      (relations) => {
        if (generation !== this.#generation) return;
        this.rooms = relations.mutualRooms;
        this.ignored = relations.ignored;
      },
      (error: unknown) => {
        console.warn('[sable profile] user relations unavailable', error);
      }
    );
  }

  dispose(): void {
    this.#generation += 1;
    this.#userId = null;
    this.#self = false;
  }
}
