import { vi } from 'vitest';

import type { ProfileView } from '#src/generated/protocol';

import { ProfileStore } from '../profile-store.svelte.js';

const pending = () => new Promise<never>(() => {});

export type CoreStub = ReturnType<typeof createCoreStub>;

export function createCoreStub<T extends Record<string, unknown>>(overrides = {} as T) {
  const stub = {
    session: null as unknown,
    accounts: [] as unknown[],
    fetchMedia: vi.fn<(...args: never[]) => Promise<Uint8Array<ArrayBuffer>>>(pending),
    forgetMedia: vi.fn<(...args: never[]) => Promise<void>>(() => Promise.resolve()),
    userProfile: vi.fn<(...args: never[]) => Promise<unknown>>(() =>
      Promise.reject(new Error('profile unavailable'))
    ),
    roomPermissions: vi.fn<(...args: never[]) => Promise<unknown>>(pending),
    roomStateEvent: vi.fn<(...args: never[]) => Promise<unknown>>(() => Promise.resolve(null)),
    roomViaServers: vi.fn<(...args: never[]) => Promise<string[]>>(() => Promise.resolve([])),
    unjoinedSpaceParents: vi.fn<(...args: never[]) => Promise<unknown[]>>(() =>
      Promise.resolve([])
    ),
    replacedRooms: vi.fn<(...args: never[]) => Promise<unknown[]>>(() => Promise.resolve([])),
    setRoomTag: vi.fn<(...args: never[]) => Promise<void>>(() => Promise.resolve()),
    markRead: vi.fn<(...args: never[]) => Promise<void>>(() => Promise.resolve()),
    reactionShortcodes: vi.fn<(...args: never[]) => Promise<unknown[]>>(() => Promise.resolve([])),
    subscribeEvents: vi.fn(() => () => {}),
    profiles: {
      get: vi.fn(() => null),
      load: vi.fn(() => Promise.reject(new Error('profile unavailable'))),
    },
    ...overrides,
  };

  const profiles = new ProfileStore({
    accountId: () => null,
    fetch: (userId) => stub.userProfile(userId as never) as Promise<ProfileView>,
  });

  return Object.assign(stub, { commands: stub, profiles });
}

export const core = createCoreStub();

export const useCoreClient = () => core;
export const provideCoreClient = vi.fn();
