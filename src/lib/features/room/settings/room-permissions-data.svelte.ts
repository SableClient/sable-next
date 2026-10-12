import type { RoomPowerLevelsView } from '#src/generated/protocol';

import type { CoreClient } from '#lib/core/client.svelte.js';
import type { PowerLevelTags } from '#lib/core/commands.svelte.js';

import { readFounders } from './room-upgrade';

export class RoomPermissionsData {
  levels = $state.raw<RoomPowerLevelsView | null>(null);
  roleTags = $state.raw<PowerLevelTags>({});
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
    this.roleTags = {};
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
        this.core.commands.powerLevelTags(roomId),
        this.core.commands.memberListThreshold(roomId).catch((error: unknown) => {
          console.debug('[sable room] member list settings unavailable', error);
          return null;
        }),
      ]);
      if (generation !== this.#generation) return;
      this.levels = levels;
      this.roleTags = tags;
      this.alwaysListedFrom = memberList;
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
