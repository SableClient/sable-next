import { createContext } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import type { CoreEvent, PronounView, SenderCosmeticsView } from '#src/generated/protocol';

import type { CoreCommands } from '#lib/core/commands.svelte.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

import { cosmeticFont } from './cosmetic-fonts';

export interface SenderCosmetics {
  colorOnLight: string | null;
  colorOnDark: string | null;
  font: string | null;
  pronouns: readonly PronounView[];
}

interface CosmeticsCore {
  commands: Pick<CoreCommands, 'roomCosmetics'>;
  subscribeEvents: (onEvent: (event: CoreEvent) => void) => () => void;
}

export class RoomCosmetics {
  readonly #users = new SvelteMap<string, SenderCosmeticsView>();
  #spaceId = $state.raw<string | null>(null);
  #roomId: string | null = null;
  #requestedSpace: string | null = null;
  #generation = 0;

  constructor(private readonly core: CosmeticsCore) {}

  get spaceId(): string | null {
    return this.#spaceId;
  }

  watch(): () => void {
    return this.core.subscribeEvents((event) => {
      if (event.type !== 'room_cosmetics_changed') return;
      if (event.room_id === this.#roomId || event.room_id === this.#spaceId) void this.#fetch();
    });
  }

  async load(roomId: string, spaceId: string | null): Promise<void> {
    if (this.#roomId !== roomId) {
      this.#users.clear();
      this.#spaceId = null;
    }
    this.#roomId = roomId;
    this.#requestedSpace = spaceId;
    await this.#fetch();
  }

  async #fetch(): Promise<void> {
    const roomId = this.#roomId;
    if (roomId === null) return;
    const generation = ++this.#generation;
    try {
      const found = await this.core.commands.roomCosmetics(roomId, this.#requestedSpace);
      if (generation !== this.#generation) return;
      this.#users.clear();
      for (const user of found.users) this.#users.set(user.user_id, user);
      this.#spaceId = found.space_id;
    } catch (error) {
      console.debug('[sable room] cosmetics unavailable', error);
    }
  }

  stored(userId: string | null | undefined): SenderCosmeticsView | undefined {
    return userId ? this.#users.get(userId) : undefined;
  }

  for(userId: string | null | undefined): SenderCosmetics | null {
    const found = this.stored(userId);
    if (!found) return null;
    const colors = preferences.renderRoomColors;
    return {
      colorOnLight: colors ? found.color_on_light : null,
      colorOnDark: colors ? found.color_on_dark : null,
      font: preferences.renderRoomFonts ? (cosmeticFont(found.font)?.family ?? null) : null,
      pronouns: found.pronouns,
    };
  }
}

const [useRoomCosmeticsContext, provideRoomCosmetics, hasRoomCosmetics] =
  createContext<RoomCosmetics>();

export { provideRoomCosmetics };

export function useRoomCosmetics(): RoomCosmetics | null {
  return hasRoomCosmetics() ? useRoomCosmeticsContext() : null;
}
