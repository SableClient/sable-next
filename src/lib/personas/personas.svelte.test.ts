import { expect, test, vi } from 'vitest';

import type { CoreEvent, PersonaCatalogView, PersonaView } from '#src/generated/protocol';

import type { CoreClient } from '#lib/core/client.svelte.js';

import { PersonaStore } from './personas.svelte.js';
import { testPersona } from './persona.js';

function persona(id: string): PersonaView {
  return {
    ...testPersona,
    id,
    display_name: id,
  };
}

function catalog(personas: PersonaView[] = []): PersonaCatalogView {
  return { personas, account: null, rooms: {}, account_rooms: [], disabled_rooms: [] };
}

function setup() {
  const listeners = new Set<(event: CoreEvent) => void>();
  const rpc = {
    list: vi.fn().mockResolvedValue(catalog()),
    save: vi.fn(),
    remove: vi.fn(),
    reorder: vi.fn(),
    disableRoom: vi.fn().mockResolvedValue(undefined),
    accountRoom: vi.fn().mockResolvedValue(undefined),
    setSelection: vi.fn().mockResolvedValue(undefined),
  };
  const core = {
    accountRevision: 0,
    rpc: { personas: rpc },
    subscribeEvents: (listener: (event: CoreEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  };
  return {
    rpc,
    store: new PersonaStore(core as unknown as CoreClient),
    emit: (event: CoreEvent) => {
      for (const listener of listeners) listener(event);
    },
  };
}

test('refreshes the catalog after a remote persona change', async () => {
  const { rpc, store, emit } = setup();
  await store.load();
  const changed = persona('changed');
  changed.avatar_url = 'mxc://example.org/avatar';
  rpc.list.mockResolvedValueOnce(catalog([changed]));

  emit({ type: 'personas_changed' });

  await vi.waitFor(() => {
    expect(store.personas).toEqual([changed]);
  });
});

test('a delayed catalog cannot overwrite a save or selection', async () => {
  const { rpc, store } = setup();
  const pending = Promise.withResolvers<PersonaCatalogView>();
  rpc.list.mockReturnValueOnce(pending.promise);
  const loading = store.load();
  const saved = persona('saved');
  rpc.save.mockResolvedValue([saved]);
  await store.save(saved);
  await store.select(null, saved.id);

  pending.resolve(catalog());
  await loading;
  expect(store.personas).toEqual([saved]);
  expect(store.account?.persona_id).toBe(saved.id);
  expect(store.loading).toBe(false);
});

test('a failed mutation leaves the pending catalog usable', async () => {
  const { rpc, store } = setup();
  const pending = Promise.withResolvers<PersonaCatalogView>();
  rpc.list.mockReturnValueOnce(pending.promise);
  const loading = store.load();
  rpc.save.mockRejectedValue(new Error('server unavailable'));
  await expect(store.save(persona('unsaved'))).rejects.toThrow('server unavailable');
  pending.resolve(catalog([persona('saved')]));
  await loading;
  expect(store.personas.map(({ id }) => id)).toEqual(['saved']);
});

test('a delayed load error cannot mark a successful save as failed', async () => {
  const { rpc, store } = setup();
  const pending = Promise.withResolvers<PersonaCatalogView>();
  rpc.list.mockReturnValueOnce(pending.promise);
  const loading = store.load();
  rpc.save.mockResolvedValue([persona('saved')]);
  await store.save(persona('saved'));
  pending.reject(new Error('old load failed'));
  await loading;
  expect(store.personas.map(({ id }) => id)).toEqual(['saved']);
  expect(store.error).toBeNull();
  expect(store.loading).toBe(false);
});

const sel = (persona_id: string) => ({ persona_id, valid_until: null, alternate_avatar_id: null });

test('choosing globally clears the room and space overrides that would win', async () => {
  const { rpc, store } = setup();
  rpc.list.mockResolvedValue({
    ...catalog([persona('a'), persona('b')]),
    rooms: { '!space': sel('a') },
    account_rooms: [],
    disabled_rooms: ['!room'],
  });
  await store.load();
  const spaces = { target: '!space', order: ['!space', '!other'] };

  await store.remember('account', '!room', spaces, 'b');

  expect(rpc.setSelection).toHaveBeenCalledWith(
    expect.objectContaining({ room_id: null, persona_id: 'b' })
  );
  expect(store.associationFor('!room')).toBeUndefined();
  expect(store.associationFor('!space')).toBeUndefined();
  expect(rpc.setSelection).not.toHaveBeenCalledWith(expect.objectContaining({ room_id: '!other' }));
});

test('the account profile in a space sends as the account there and drops the room override', async () => {
  const { rpc, store } = setup();
  rpc.list.mockResolvedValue({ ...catalog([persona('a')]), rooms: { '!room': sel('a') } });
  await store.load();

  await store.remember('space', '!room', { target: '!space', order: ['!space'] }, null);

  expect(rpc.accountRoom).toHaveBeenCalledWith({ room_id: '!space' });
  expect(rpc.disableRoom).not.toHaveBeenCalled();
  expect(store.associationFor('!space')).toBe('account');
  expect(store.associationFor('!room')).toBeUndefined();
});

test('the picker opens on the closest scope holding a selection', async () => {
  const { rpc, store } = setup();
  rpc.list.mockResolvedValue({ ...catalog([persona('a')]), rooms: { '!space': sel('a') } });
  await store.load();
  const spaces = { target: '!space', order: ['!space'] };

  expect(store.scopeFor('picker', '!room', spaces)).toBe('space');
  expect(store.scopeFor('room', '!room', spaces)).toBe('room');
  expect(store.scopeFor('space', '!room', { target: null, order: [] })).toBe('account');
});

test('a failed load retries when sync comes back', async () => {
  const { rpc, store, emit } = setup();
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  rpc.list.mockRejectedValueOnce(new Error('offline'));
  await store.load();
  expect(store.error).toBe('personas.loadFailed');
  const restored = persona('restored');
  rpc.list.mockResolvedValueOnce(catalog([restored]));

  emit({ type: 'sync_status', state: 'offline' });
  expect(rpc.list).toHaveBeenCalledTimes(1);
  emit({ type: 'sync_status', state: 'live' });

  await vi.waitFor(() => {
    expect(store.personas).toEqual([restored]);
  });
  expect(store.error).toBeNull();
});
