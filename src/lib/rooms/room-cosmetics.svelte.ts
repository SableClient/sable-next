import { createContext } from 'svelte';
import { SvelteMap } from 'svelte/reactivity';
import type { CoreEvent, PronounView, SenderCosmeticsView } from '#src/generated/protocol';

import type { CoreCommands } from '#lib/core/commands.svelte.js';
import { preferences } from '#lib/settings/preferences.svelte.js';

export interface SenderCosmetics {
  colorOnLight: string | null;
  colorOnDark: string | null;
  pronouns: readonly PronounView[];
}

interface CosmeticsCore {
  commands: Pick<CoreCommands, 'roomCosmetics'>;
  subscribeEvents: (onEvent: (event: CoreEvent) => void) => () => void;
  userProfile?: (userId: string) => Promise<ProfileIdentity | null>;
}

export interface ShownIdentity {
  name: string | null;
  avatar: string | null;
}

interface ProfileIdentity {
  display_name: string | null;
  avatar_url: string | null;
}

export class RoomCosmetics {
  readonly #users = new SvelteMap<string, SenderCosmeticsView>();
  #spaceId = $state.raw<string | null>(null);
  readonly #profiles = new SvelteMap<string, ProfileIdentity>();
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
      void this.#loadProfiles(found.users, generation);
    } catch (error) {
      console.debug('[sable room] cosmetics unavailable', error);
    }
  }

  async #loadProfiles(users: readonly SenderCosmeticsView[], generation: number): Promise<void> {
    if (!this.core.userProfile) return;
    const missing = users.filter(
      (user) =>
        (user.space_display_name !== null || user.space_avatar_url !== null) &&
        !this.#profiles.has(user.user_id)
    );
    if (missing.length === 0) return;
    const loaded = await Promise.all(
      missing.map(
        async (user) =>
          [user.user_id, await this.core.userProfile?.(user.user_id).catch(() => null)] as const
      )
    );
    if (generation !== this.#generation) return;
    for (const [userId, profile] of loaded) if (profile) this.#profiles.set(userId, profile);
  }

  stored(userId: string | null | undefined): SenderCosmeticsView | undefined {
    return userId ? this.#users.get(userId) : undefined;
  }

  identity(userId: string | null | undefined, own: ShownIdentity): ShownIdentity {
    const found = this.stored(userId);
    const profile = userId ? this.#profiles.get(userId) : undefined;
    if (!found || !profile) return own;
    return {
      name:
        found.space_display_name !== null && own.name === profile.display_name
          ? found.space_display_name
          : own.name,
      avatar:
        found.space_avatar_url !== null && own.avatar === profile.avatar_url
          ? found.space_avatar_url
          : own.avatar,
    };
  }

  for(userId: string | null | undefined): SenderCosmetics | null {
    const found = this.stored(userId);
    if (!found) return null;
    const colors = preferences.renderRoomColors;
    return {
      colorOnLight: colors ? found.color_on_light : null,
      colorOnDark: colors ? found.color_on_dark : null,
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
