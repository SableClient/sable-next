import { vi, type Mock } from 'vitest';
import { defaultE2eePolicy } from '#lib/deployment/e2ee-policy.js';
import { MemberPreviews } from '#lib/rooms/member-previews.svelte.js';
import { createRpc, type OAuthMetadataView, type Rpc } from '#src/generated/protocol';

const pending = () => new Promise<never>(() => {});

type MockMethods<D> = {
  [M in keyof D]: D[M] extends (...args: infer A) => infer R ? Mock<(...args: A) => R> : never;
};

export type MockRpc = { [D in keyof Rpc]: MockMethods<Rpc[D]> };

export type RpcOverrides = { [D in keyof Rpc]?: Partial<Record<keyof Rpc[D], unknown>> };

/** Every core method as a mock that never settles, with `layers` replacing methods by domain. */
export function mockRpc(...layers: RpcOverrides[]): MockRpc {
  return Object.fromEntries(
    Object.entries(createRpc(pending)).map(([domain, methods]) => [
      domain,
      Object.assign(
        Object.fromEntries(Object.keys(methods).map((method) => [method, vi.fn(pending)])),
        ...layers.map((layer) => layer[domain as keyof Rpc] ?? {})
      ),
    ])
  ) as MockRpc;
}

export type CoreStub = ReturnType<typeof createCoreStub>;

export function createCoreStub<T extends Record<string, unknown> & { rpc?: RpcOverrides }>(
  overrides = {} as T
) {
  const { rpc: rpcOverrides = {}, ...rest } = overrides;
  const stub = {
    memberPreviews: new MemberPreviews(),
    session: null as unknown,
    accounts: [] as unknown[],
    fetchMedia: vi.fn<(...args: never[]) => Promise<Uint8Array<ArrayBuffer>>>(pending),
    forgetMedia: vi.fn<(...args: never[]) => Promise<void>>(() => Promise.resolve()),
    userProfile: vi.fn<(...args: never[]) => Promise<unknown>>(() =>
      Promise.reject(new Error('profile unavailable'))
    ),
    cachedUserProfile: vi.fn<(...args: never[]) => unknown>(() => null),
    forgetProfileFailure: vi.fn(),
    refreshUserProfile: vi.fn<(...args: never[]) => Promise<unknown>>(() =>
      Promise.reject(new Error('profile unavailable'))
    ),
    e2eePolicy: vi.fn(() => Promise.resolve(defaultE2eePolicy)),
    subscribeEvents: vi.fn(() => () => {}),
    onProfileChanged: vi.fn(() => () => {}),
    oauthMetadata: null as OAuthMetadataView | null,
    rpc: mockRpc(
      {
        members: {
          powerLevelTags: vi.fn(() => Promise.resolve({})),
          member: vi.fn(() => Promise.resolve(null)),
        },
        messages: {
          reactionShortcodes: vi.fn(() => Promise.resolve([])),
          frequentReactions: vi.fn(() => Promise.resolve([])),
          rememberEmoji: vi.fn(() => Promise.resolve(null)),
        },
        room_state: {
          event: vi.fn(() => Promise.resolve(null)),
          memberListThreshold: vi.fn(() => Promise.resolve(null)),
          banner: vi.fn(() => Promise.resolve(null)),
          historyVisibility: vi.fn(() => Promise.resolve('shared')),
          abbreviations: vi.fn(() => Promise.resolve([])),
          accountDataTypes: vi.fn(() => Promise.resolve([])),
        },
        rooms: {
          canonicalAlias: vi.fn(() => Promise.resolve({ alias: null, alt_aliases: [] })),
          viaServers: vi.fn(() => Promise.resolve([])),
          replacedRooms: vi.fn(() => Promise.resolve([])),
          setTag: vi.fn(() => Promise.resolve(null)),
        },
        spaces: { unjoinedSpaceParents: vi.fn(() => Promise.resolve([])) },
        timeline: { markRead: vi.fn(() => Promise.resolve(null)) },
      },
      rpcOverrides
    ),
    ...rest,
  };
  return Object.assign(stub, { media: stub });
}

export const core = createCoreStub();

export const useCoreClient = () => core;
export const provideCoreClient = vi.fn();
