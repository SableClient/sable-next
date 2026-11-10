import { createContext } from 'svelte';

import type {
  CoreEvent,
  PersonaCatalogView,
  PersonaSelectionView,
  PersonaView,
} from '#src/generated/protocol';

import type { CoreClient } from '#lib/core/client.svelte.js';

import type { PersonaSelectionScope } from '#lib/settings/definitions.js';

import { reorderPersonas, type PersonaAssociation, type SelectionScope } from './persona.js';

export interface PersonaSpaces {
  target: string | null;
  order: readonly string[];
}

export class PersonaStore {
  private catalog = $state.raw<PersonaCatalogView>({
    personas: [],
    account: null,
    rooms: {},
    account_rooms: [],
    disabled_rooms: [],
  });

  readonly personas = $derived(this.catalog.personas);
  readonly account = $derived(this.catalog.account);
  readonly rooms = $derived(this.catalog.rooms);
  readonly accountRooms = $derived(this.catalog.account_rooms);
  readonly disabledRooms = $derived(this.catalog.disabled_rooms);

  loading = $state(false);
  error = $state<string | null>(null);

  private loaded = false;
  private inFlight: Promise<void> | null = null;
  private refreshAfterFlight = false;
  private revision: number | null = null;

  constructor(private readonly core: CoreClient) {
    this.core.subscribeEvents((event: CoreEvent) => {
      if (event.type === 'sync_status') {
        if (event.state !== 'offline' && !this.loaded) void this.load();
        return;
      }
      if (event.type !== 'personas_changed') return;

      if (this.inFlight !== null) {
        this.refreshAfterFlight = true;
        return;
      }
      void this.load(true);
    });
  }

  async load(force = false): Promise<void> {
    if (this.revision !== this.core.accountRevision) this.reset();
    if (this.loaded && !force) return;
    this.inFlight ??= this.fetch();
    await this.inFlight;
  }

  private reset(): void {
    this.revision = this.core.accountRevision;
    this.catalog = {
      personas: [],
      account: null,
      rooms: {},
      account_rooms: [],
      disabled_rooms: [],
    };
    this.error = null;
    this.loaded = false;
    this.inFlight = null;
    this.refreshAfterFlight = false;
  }

  private async fetch(): Promise<void> {
    const revision = this.revision;
    const previous = this.catalog;
    this.loading = true;
    try {
      const catalog = await this.core.rpc.personas.list();
      if (revision !== this.revision || previous !== this.catalog) return;
      this.catalog = catalog;
      this.loaded = true;
      this.error = null;
    } catch (cause) {
      if (revision !== this.revision || previous !== this.catalog) return;
      console.warn('[sable personas] loading the catalog failed', cause);
      this.error = 'personas.loadFailed';
    } finally {
      if (revision === this.revision) {
        this.loading = false;
        this.inFlight = null;
        if (this.refreshAfterFlight) {
          this.refreshAfterFlight = false;
          void this.load(true);
        }
      }
    }
  }

  async save(
    persona: PersonaView,
    previousId: string | null = null,
    basePersona: PersonaView | null = null
  ): Promise<void> {
    const replaced = previousId ?? persona.id;
    const base =
      basePersona ?? this.personas.find((existing) => existing.id === replaced) ?? persona;
    const personas = await this.core.rpc.personas.save({
      persona: $state.snapshot(persona),
      base_persona: $state.snapshot(base),
      previous_id: previousId,
    });
    this.catalog = { ...this.catalog, personas };
    if (previousId !== null && previousId !== persona.id) this.repoint(previousId, persona.id);
  }

  async remove(id: string): Promise<void> {
    const personas = await this.core.rpc.personas.remove({ id });
    this.catalog = { ...this.catalog, personas };
    this.repoint(id, null);
  }

  async removeAll(): Promise<void> {
    for (const { id } of this.personas) await this.remove(id);
  }

  async reorder(from: number, to: number): Promise<void> {
    if (to < 0 || to >= this.personas.length || from === to) return;
    const ids = reorderPersonas(this.personas, from, to).map((persona) => persona.id);
    const personas = await this.core.rpc.personas.reorder({ ids });
    this.catalog = { ...this.catalog, personas };
  }

  selectionFor(roomId: string | null): PersonaSelectionView | null {
    return roomId === null ? this.account : (this.rooms[roomId] ?? null);
  }

  associationFor(roomId: string): PersonaAssociation {
    if (this.disabledIn(roomId)) return false;
    if (this.accountRooms.includes(roomId)) return 'account';
    return this.rooms[roomId] ?? undefined;
  }

  disabledIn(roomId: string): boolean {
    return this.disabledRooms.includes(roomId);
  }

  async useAccount(roomId: string): Promise<void> {
    await this.core.rpc.personas.accountRoom({ room_id: roomId });
    this.catalog = {
      ...this.catalog,
      rooms: Object.fromEntries(Object.entries(this.rooms).filter(([key]) => key !== roomId)),
      account_rooms: [...this.accountRooms.filter((key) => key !== roomId), roomId],
      disabled_rooms: this.disabledRooms.filter((key) => key !== roomId),
    };
  }

  async select(
    roomId: string | null,
    personaId: string | null,
    validUntil: number | null = null,
    alternateAvatarId: string | null = null
  ): Promise<void> {
    await this.core.rpc.personas.setSelection({
      room_id: roomId,
      persona_id: personaId,
      valid_until: validUntil,
      alternate_avatar_id: alternateAvatarId,
    });
    const selection =
      personaId === null
        ? null
        : {
            persona_id: personaId,
            valid_until: validUntil,
            alternate_avatar_id: alternateAvatarId,
          };

    if (roomId === null) {
      this.catalog = { ...this.catalog, account: selection };
      return;
    }
    const rest = Object.fromEntries(Object.entries(this.rooms).filter(([key]) => key !== roomId));
    this.catalog = {
      ...this.catalog,
      account_rooms: this.accountRooms.filter((key) => key !== roomId),
      disabled_rooms: this.disabledRooms.filter((key) => key !== roomId),
      rooms: selection === null ? rest : { ...rest, [roomId]: selection },
    };
  }

  scopeFor(mode: PersonaSelectionScope, roomId: string, spaces: PersonaSpaces): SelectionScope {
    if (mode === 'picker') {
      if (this.associationFor(roomId) !== undefined) return 'room';
      if (spaces.target !== null && this.associationFor(spaces.target) !== undefined) {
        return 'space';
      }
      return 'account';
    }
    if (mode === 'space' && spaces.target === null) return 'account';
    return mode;
  }

  async remember(
    scope: SelectionScope,
    roomId: string,
    spaces: PersonaSpaces,
    personaId: string | null,
    alternateAvatarId: string | null = null
  ): Promise<void> {
    const target = scope === 'room' ? roomId : scope === 'space' ? spaces.target : null;
    const overriding =
      scope === 'room'
        ? []
        : target === null
          ? [roomId, ...spaces.order]
          : [roomId, ...spaces.order.slice(0, spaces.order.indexOf(target))];

    if (target !== null && personaId === null) await this.useAccount(target);
    else await this.select(target, personaId, null, alternateAvatarId);
    for (const id of overriding) {
      if (this.associationFor(id) !== undefined) await this.select(id, null);
    }
  }

  private repoint(from: string, to: string | null): void {
    const account =
      this.account?.persona_id === from
        ? to === null
          ? null
          : { ...this.account, persona_id: to }
        : this.account;
    const rooms = Object.fromEntries(
      Object.entries(this.rooms).flatMap(([roomId, selection]) => {
        if (selection.persona_id !== from) return [[roomId, selection]];
        return to === null ? [] : [[roomId, { ...selection, persona_id: to }]];
      })
    );
    this.catalog = { ...this.catalog, account, rooms };
  }
}

export const [usePersonaStore, providePersonaStore] = createContext<PersonaStore>();
