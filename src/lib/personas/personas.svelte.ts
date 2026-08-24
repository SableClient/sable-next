import { createContext } from 'svelte';

import type { PersonaSelectionView } from '#src/generated/PersonaSelectionView';
import type { PersonaView } from '#src/generated/PersonaView';

import type { CoreClient } from '#lib/core/client.svelte.js';

export class PersonaStore {
  personas = $state<PersonaView[]>([]);
  account = $state<PersonaSelectionView | null>(null);
  rooms = $state<Record<string, PersonaSelectionView>>({});
  loading = $state(false);
  error = $state<string | null>(null);

  private loaded = false;
  private inFlight: Promise<void> | null = null;

  constructor(private readonly core: CoreClient) {}

  async load(force = false): Promise<void> {
    if (this.loaded && !force) return;
    this.inFlight ??= this.fetch();
    await this.inFlight;
  }

  private async fetch(): Promise<void> {
    this.loading = true;
    try {
      const catalog = await this.core.personas();
      this.personas = catalog.personas;
      this.account = catalog.account;
      this.rooms = catalog.rooms;
      this.loaded = true;
      this.error = null;
    } catch (cause) {
      console.warn('[sable personas] loading the catalog failed', cause);
      this.error = 'personas.loadFailed';
    } finally {
      this.loading = false;
      this.inFlight = null;
    }
  }

  async save(persona: PersonaView, previousId: string | null = null): Promise<void> {
    this.personas = await this.core.savePersona(persona, previousId);
    if (previousId !== null && previousId !== persona.id) this.repoint(previousId, persona.id);
  }

  async remove(id: string): Promise<void> {
    this.personas = await this.core.removePersona(id);
    this.repoint(id, null);
  }

  selectionFor(roomId: string | null): PersonaSelectionView | null {
    return roomId === null ? this.account : (this.rooms[roomId] ?? null);
  }

  async select(
    roomId: string | null,
    personaId: string | null,
    validUntil: number | null = null
  ): Promise<void> {
    await this.core.setPersonaSelection(roomId, personaId, validUntil);
    const selection =
      personaId === null ? null : { persona_id: personaId, valid_until: validUntil };

    if (roomId === null) {
      this.account = selection;
      return;
    }
    const rest = Object.fromEntries(Object.entries(this.rooms).filter(([key]) => key !== roomId));
    this.rooms = selection === null ? rest : { ...rest, [roomId]: selection };
  }

  private repoint(from: string, to: string | null): void {
    if (this.account?.persona_id === from) {
      this.account = to === null ? null : { ...this.account, persona_id: to };
    }

    this.rooms = Object.fromEntries(
      Object.entries(this.rooms).flatMap(([roomId, selection]) => {
        if (selection.persona_id !== from) return [[roomId, selection]];
        return to === null ? [] : [[roomId, { ...selection, persona_id: to }]];
      })
    );
  }
}

export const [usePersonaStore, providePersonaStore] = createContext<PersonaStore>();
