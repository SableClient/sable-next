import type { DmSpaceLink } from '#src/generated/protocol';

import type { CoreClient } from '#lib/core/client.svelte.js';
import { AccountDataSync } from '#lib/core/account-data-sync.js';

export const DM_SPACES_EVENT = 'moe.sable.dm_spaces';

type Links = ReadonlyMap<string, readonly string[]>;

function toLinks(links: readonly DmSpaceLink[]): Links {
  return new Map(links.map((link) => [link.room_id, link.space_ids]));
}

class DmSpaces {
  links = $state.raw<Links>(new Map());

  private readonly sync = new AccountDataSync([DM_SPACES_EVENT], (generation) =>
    this.pull(generation)
  );

  start(core: CoreClient): void {
    this.sync.start(core);
  }

  stop(): void {
    this.sync.stop();
    this.links = new Map();
  }

  spacesOf(roomId: string): readonly string[] {
    return this.links.get(roomId) ?? [];
  }

  async set(roomId: string, spaceIds: readonly string[]): Promise<void> {
    const core = this.sync.core;
    if (core === null) return;
    const generation = this.sync.generation;
    const previous = this.links;
    const next: Links = new Map([
      ...[...previous].filter(([id]) => id !== roomId),
      ...(spaceIds.length === 0 ? [] : [[roomId, spaceIds] as const]),
    ]);
    this.links = next;
    try {
      const stored = await core.rpc.account.setDmSpaces({
        room_id: roomId,
        space_ids: [...spaceIds],
      });
      if (generation === this.sync.generation) this.links = toLinks(stored);
    } catch (error) {
      if (this.links === next) this.links = previous;
      throw error;
    }
  }

  private async pull(generation: number): Promise<void> {
    try {
      const core = this.sync.core;
      if (core === null) return;
      const links = await core.rpc.account.dmSpaces();
      if (generation === this.sync.generation) this.links = toLinks(links);
    } catch (error) {
      console.debug('[sable rooms] private DM spaces unavailable', error);
    }
  }
}

export const dmSpaces = new DmSpaces();
