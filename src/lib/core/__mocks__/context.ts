import { vi } from 'vitest';

const pending = () => new Promise<never>(() => {});

export type CoreStub = ReturnType<typeof createCoreStub>;

export function createCoreStub<T extends Record<string, unknown>>(overrides = {} as T) {
  const stub = {
    session: null as unknown,
    fetchMedia: vi.fn<(...args: never[]) => Promise<Uint8Array<ArrayBuffer>>>(pending),
    userProfile: vi.fn<(...args: never[]) => Promise<unknown>>(() =>
      Promise.reject(new Error('profile unavailable'))
    ),
    roomPermissions: vi.fn<(...args: never[]) => Promise<unknown>>(pending),
    roomStateEvent: vi.fn<(...args: never[]) => Promise<unknown>>(() => Promise.resolve(null)),
    roomViaServers: vi.fn<(...args: never[]) => Promise<string[]>>(() => Promise.resolve([])),
    setRoomTag: vi.fn<(...args: never[]) => Promise<void>>(() => Promise.resolve()),
    markRead: vi.fn<(...args: never[]) => Promise<void>>(() => Promise.resolve()),
    subscribeEvents: vi.fn(() => () => {}),
    ...overrides,
  };

  return Object.assign(stub, { commands: stub });
}

export const core = createCoreStub();

export const useCoreClient = () => core;
export const provideCoreClient = vi.fn();
