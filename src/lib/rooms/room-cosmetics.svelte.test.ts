import { describe, expect, test, vi } from 'vitest';
import type { RoomCosmeticsView, SenderCosmeticsView } from '#src/generated/protocol';

import { RoomCosmetics } from './room-cosmetics.svelte.js';

const ALICE = '@alice:example.org';
const profile = { display_name: 'Alice', avatar_url: 'mxc://example.org/profile' };

function cosmetics(
  user: Partial<SenderCosmeticsView>,
  known = true,
  userProfile = vi.fn().mockResolvedValue(known ? profile : null)
): RoomCosmetics {
  const view: RoomCosmeticsView = {
    space_id: '!space:example.org',
    users: [
      {
        user_id: ALICE,
        color_on_light: null,
        color_on_dark: null,
        pronouns: [],
        space_display_name: null,
        space_avatar_url: null,
        ...user,
      },
    ],
  };
  const store = new RoomCosmetics({
    commands: { roomCosmetics: vi.fn().mockResolvedValue(view) },
    subscribeEvents: () => () => {},
    userProfile,
  });
  void store.load('!room:example.org', '!space:example.org');
  return store;
}

async function settled(store: RoomCosmetics): Promise<void> {
  await vi.waitFor(() => {
    expect(store.stored(ALICE)).toBeDefined();
    expect(store.identity(ALICE, { name: 'Alice', avatar: profile.avatar_url }).name).not.toBe(
      'Alice'
    );
  });
}

describe('RoomCosmetics.identity', () => {
  test('a room with no look of its own takes the space name and picture', async () => {
    const store = cosmetics({
      space_display_name: 'Space Alice',
      space_avatar_url: 'mxc://example.org/space',
    });
    await settled(store);

    expect(store.identity(ALICE, { name: 'Alice', avatar: 'mxc://example.org/profile' })).toEqual({
      name: 'Space Alice',
      avatar: 'mxc://example.org/space',
    });
  });

  test("a room's own name and picture win over the space's", async () => {
    const store = cosmetics({
      space_display_name: 'Space Alice',
      space_avatar_url: 'mxc://example.org/space',
    });
    await settled(store);

    expect(store.identity(ALICE, { name: 'Room Alice', avatar: 'mxc://example.org/room' })).toEqual(
      { name: 'Room Alice', avatar: 'mxc://example.org/room' }
    );
  });

  test('nothing is replaced until the profile is known', async () => {
    const store = cosmetics({ space_display_name: 'Space Alice' }, false);
    await vi.waitFor(() => {
      expect(store.stored(ALICE)).toBeDefined();
    });

    expect(store.identity(ALICE, { name: 'Alice', avatar: null })).toEqual({
      name: 'Alice',
      avatar: null,
    });
  });

  test('a profile that failed to load is fetched again', async () => {
    vi.useFakeTimers();
    try {
      const userProfile = vi
        .fn()
        .mockRejectedValueOnce(new Error('rate limited'))
        .mockResolvedValue(profile);
      const store = cosmetics({ space_display_name: 'Space Alice' }, true, userProfile);
      await vi.advanceTimersByTimeAsync(0);
      expect(store.identity(ALICE, { name: 'Alice', avatar: null }).name).toBe('Alice');

      await vi.advanceTimersByTimeAsync(10_000);
      expect(store.identity(ALICE, { name: 'Alice', avatar: null }).name).toBe('Space Alice');
      expect(userProfile).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('a profile change is fetched again rather than compared against the old profile', async () => {
    const listeners = new Set<(userId: string) => void>();
    const userProfile = vi
      .fn()
      .mockResolvedValueOnce(profile)
      .mockResolvedValue({ ...profile, display_name: 'New Alice' });
    const store = new RoomCosmetics({
      commands: {
        roomCosmetics: vi.fn().mockResolvedValue({
          space_id: '!space:example.org',
          users: [
            {
              user_id: ALICE,
              color_on_light: null,
              color_on_dark: null,
              pronouns: [],
              space_display_name: 'Space Alice',
              space_avatar_url: null,
            },
          ],
        }),
      },
      subscribeEvents: () => () => {},
      userProfile,
      onProfileChanged: (listener) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
    });
    const stop = store.watch();
    void store.load('!room:example.org', '!space:example.org');
    await settled(store);

    for (const listener of listeners) listener(ALICE);

    await vi.waitFor(() => {
      expect(store.identity(ALICE, { name: 'New Alice', avatar: null }).name).toBe('Space Alice');
    });
    stop();
    expect(listeners.size).toBe(0);
  });
});
