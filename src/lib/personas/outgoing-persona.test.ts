import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PersonaSelectionView, PersonaView } from '#src/generated/protocol';
import { preferences } from '#lib/settings/preferences.svelte.js';

import { outgoingPersona } from './outgoing-persona.js';
import type { PersonaStore } from './personas.svelte.js';

function persona(overrides: Partial<PersonaView>): PersonaView {
  return {
    id: 'p1',
    display_name: 'Alice',
    avatar_url: 'mxc://main',
    triggers: [],
    alternate_avatars: [{ id: 'alt', avatar_url: 'mxc://alt' }],
    ...overrides,
  } as PersonaView;
}

function store(
  personas: PersonaView[],
  rooms: Record<string, PersonaSelectionView>,
  account: PersonaSelectionView | null = null
) {
  const remember = vi.fn(() => Promise.resolve());
  return {
    personas,
    remember,
    scopeFor: (mode: string) => mode,
    selectionFor: (id: string | null) => (id === null ? account : (rooms[id] ?? null)),
    associationFor: (id: string) => rooms[id],
    save: vi.fn(() => Promise.resolve()),
  } as unknown as PersonaStore & { remember: typeof remember };
}

const selection = (alt: string | null): PersonaSelectionView => ({
  persona_id: 'p1',
  valid_until: null,
  alternate_avatar_id: alt,
});

describe('outgoingPersona alternate avatars', () => {
  beforeEach(() => {
    preferences.personaProxying = true;
    preferences.personaKeepAfterShorthand = true;
    preferences.personaSelectionScope = 'room';
  });

  it('sends the alternate avatar picked for the room', () => {
    const personas = store([persona({})], { '!r': selection('alt') });
    const { persona: sent } = outgoingPersona(personas, '!r', [], 'hello');
    expect(sent?.avatar_url).toBe('mxc://alt');
  });

  it('does not keep the picked alternate avatar when a shorthand without one latches', () => {
    const personas = store(
      [
        persona({
          triggers: [
            { prefix: 'a:', suffix: null, keep_trigger: false, alternate_avatar_id: null },
          ],
        }),
      ],
      { '!r': selection('alt') }
    );
    const { persona: sent } = outgoingPersona(personas, '!r', [], 'a:hello');
    expect(sent?.avatar_url).toBe('mxc://main');
    expect(personas.remember).toHaveBeenCalledWith(
      'room',
      '!r',
      { target: null, order: [] },
      'p1',
      null
    );
  });
});
