import { createContext } from 'svelte';

import type { CoreCommands } from '#lib/core/commands.svelte.js';

import { abbreviationPattern, buildAbbreviationMap } from './abbreviations';
import {
  ABBREVIATIONS_EVENT_TYPE,
  readAbbreviations,
  type AbbreviationEntry,
} from './settings/abbreviations';

export const abbreviationChanges = $state({ version: 0 });

export function abbreviationsChanged(): void {
  abbreviationChanges.version += 1;
}

export class RoomAbbreviations {
  #map = $state.raw<ReadonlyMap<string, string>>(buildAbbreviationMap([]));
  #pattern = $derived(abbreviationPattern(this.#map));
  #roomId: string | null = null;
  #generation = 0;

  constructor(private readonly commands: Pick<CoreCommands, 'roomStateEvent'>) {}

  get map(): ReadonlyMap<string, string> {
    return this.#map;
  }

  get pattern(): RegExp | null {
    return this.#pattern;
  }

  async load(roomId: string, spaceIds: readonly string[]): Promise<void> {
    const generation = ++this.#generation;
    if (this.#roomId !== roomId) {
      this.#roomId = roomId;
      this.#map = buildAbbreviationMap([]);
    }

    const groups = await Promise.all([...spaceIds, roomId].map((id) => this.#entries(id)));
    if (generation !== this.#generation) return;
    this.#map = buildAbbreviationMap(groups.flat());
  }

  async #entries(roomId: string): Promise<AbbreviationEntry[]> {
    try {
      return readAbbreviations(
        await this.commands.roomStateEvent(roomId, ABBREVIATIONS_EVENT_TYPE)
      );
    } catch (error) {
      console.debug('[sable room] abbreviations unavailable', error);
      return [];
    }
  }
}

export const [useRoomAbbreviations, provideRoomAbbreviations, hasRoomAbbreviations] =
  createContext<RoomAbbreviations>();
