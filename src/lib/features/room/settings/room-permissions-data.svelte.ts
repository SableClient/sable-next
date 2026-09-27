import type { RoomPowerLevelsView } from '#src/generated/protocol';

import type { CoreClient } from '#lib/core/client.svelte.js';

import { readFounders } from './room-upgrade';
import { MEMBER_LIST_EVENT_TYPE, readAlwaysListedFrom } from './member-list.svelte.js';
import { POWER_LEVEL_TAGS_EVENT_TYPE } from './power-level-tags';

export class RoomPermissionsData {
  levels = $state.raw<RoomPowerLevelsView | null>(null);
  rawRoleTags = $state.raw<unknown>(null);
  founders = $state.raw<string[]>([]);
  alwaysListedFrom = $state<number | null>(null);
  loading = $state(false);
  failed = $state(false);

  #roomId: string | null = null;
  #generation = 0;

  constructor(private readonly core: CoreClient) {}

  sync(roomId: string | null): void {
    if (this.#roomId === roomId) return;
    this.#roomId = roomId;
    this.#generation += 1;
    this.levels = null;
    this.rawRoleTags = null;
    this.founders = [];
    this.alwaysListedFrom = null;
    this.loading = false;
    this.failed = false;
    if (roomId !== null) void this.#load(roomId, this.#generation);
  }

  dispose(): void {
    this.#generation += 1;
    this.#roomId = null;
  }

  async #load(roomId: string, generation: number): Promise<void> {
    this.loading = true;
    try {
      void this.#loadFounders(roomId, generation);
      const [levels, tags, memberList] = await Promise.all([
        this.core.commands.roomPowerLevels(roomId),
        this.core.commands.roomStateEvent(roomId, POWER_LEVEL_TAGS_EVENT_TYPE),
        this.core.commands
          .roomStateEvent(roomId, MEMBER_LIST_EVENT_TYPE)
          .catch((error: unknown) => {
            console.debug('[sable room] member list settings unavailable', error);
            return null;
          }),
      ]);
      if (generation !== this.#generation) return;
      this.levels = levels;
      this.rawRoleTags = tags ?? null;
      this.alwaysListedFrom = readAlwaysListedFrom(memberList);
    } catch (error) {
      console.warn('[sable room] power levels unavailable', error);
      if (generation === this.#generation) this.failed = true;
    } finally {
      if (generation === this.#generation) this.loading = false;
    }
  }

  async #loadFounders(roomId: string, generation: number): Promise<void> {
    try {
      const events = await this.core.commands.roomStateEventsRaw(roomId, 'm.room.create', '');
      if (generation === this.#generation) this.founders = readFounders(events[0]);
    } catch (error) {
      console.debug('[sable room] founders unavailable', error);
      if (generation === this.#generation) this.founders = [];
    }
  }
}
