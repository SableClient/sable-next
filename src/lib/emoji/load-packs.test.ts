import { expect, test, vi } from 'vitest';
import type { ImagePackView } from '#src/generated/protocol';
import { invalidatePacks, isPackAccountDataEvent, loadPacks } from './load-packs';

interface Listing {
  packs: ImagePackView[];
  complete: boolean;
}

function listing(packs: ImagePackView[], complete = true): Listing {
  return { packs, complete };
}

const cached: ImagePackView[] = [
  {
    id: 'cached',
    origin: 'room',
    room_id: '!room:example.org',
    name: null,
    avatar_url: null,
    attribution: null,
    usage: ['emoticon', 'sticker'],
    images: [],
  },
];

test('cached packs are available while the full state request remains pending', async () => {
  const refresh = Promise.withResolvers<Listing>();
  const commands = {
    imagePackListing: vi.fn((_room: string, cachedOnly = false) =>
      cachedOnly ? Promise.resolve(listing(cached, false)) : refresh.promise
    ),
  };
  const apply = vi.fn();
  const loading = loadPacks(commands, '!room:example.org', apply);
  await vi.waitFor(() => {
    expect(apply).toHaveBeenCalledExactlyOnceWith(cached);
  });
  expect(commands.imagePackListing).toHaveBeenLastCalledWith('!room:example.org');
  refresh.resolve(listing([]));
  await loading;
  expect(apply).toHaveBeenLastCalledWith([]);
});

test('keeps a complete pack snapshot for later picker mounts', async () => {
  const commands = {
    imagePackListing: vi.fn((_room: string, cachedOnly = false) =>
      Promise.resolve(cachedOnly ? listing([], false) : listing(cached))
    ),
  };

  await loadPacks(commands, '!room:example.org', vi.fn());
  const apply = vi.fn();
  await loadPacks(commands, '!room:example.org', apply);

  expect(commands.imagePackListing).toHaveBeenCalledTimes(2);
  expect(commands.imagePackListing).toHaveBeenNthCalledWith(1, '!room:example.org', true);
  expect(commands.imagePackListing).toHaveBeenNthCalledWith(2, '!room:example.org');
  expect(apply).toHaveBeenCalledExactlyOnceWith(cached);
});

test('does not keep a snapshot of an incomplete listing', async () => {
  let refreshes = 0;
  const commands = {
    imagePackListing: vi.fn((_room: string, cachedOnly = false) => {
      if (cachedOnly) return Promise.resolve(listing([], false));
      refreshes += 1;
      return Promise.resolve(refreshes === 1 ? listing([], false) : listing(cached));
    }),
  };

  const first = vi.fn();
  await loadPacks(commands, '!room:example.org', first);
  const second = vi.fn();
  await loadPacks(commands, '!room:example.org', second);

  expect(first).toHaveBeenCalledExactlyOnceWith([]);
  expect(commands.imagePackListing).toHaveBeenCalledTimes(4);
  expect(second).toHaveBeenLastCalledWith(cached);
});

test('does not share a pack snapshot between accounts', async () => {
  const commands = {
    imagePackListing: vi.fn((_room: string, cachedOnly = false) =>
      Promise.resolve(cachedOnly ? listing([], false) : listing(cached))
    ),
  };

  await loadPacks(commands, '!room:example.org', vi.fn(), 'account-one');
  await loadPacks(commands, '!room:example.org', vi.fn(), 'account-two');

  expect(commands.imagePackListing).toHaveBeenCalledTimes(4);
});

test('recognizes account data that changes available packs', () => {
  expect(isPackAccountDataEvent('im.ponies.user_emotes')).toBe(true);
  expect(isPackAccountDataEvent('im.ponies.emote_rooms')).toBe(true);
  expect(isPackAccountDataEvent('m.image_pack.rooms')).toBe(true);
  expect(isPackAccountDataEvent('m.direct')).toBe(false);
});

test('reloads packs after an explicit invalidation', async () => {
  const commands = {
    imagePackListing: vi.fn((_room: string, cachedOnly = false) =>
      Promise.resolve(cachedOnly ? listing([], false) : listing(cached))
    ),
  };

  await loadPacks(commands, '!room:example.org', vi.fn());
  invalidatePacks(commands);
  await loadPacks(commands, '!room:example.org', vi.fn());

  expect(commands.imagePackListing).toHaveBeenCalledTimes(4);
});

test('a mount whose refresh is invalidated while pending waits for the fresh listing', async () => {
  const first = Promise.withResolvers<Listing>();
  const second = Promise.withResolvers<Listing>();
  const fresh: ImagePackView[] = [{ ...cached[0], id: 'fresh' }];
  let refreshes = 0;
  const commands = {
    imagePackListing: vi.fn((_room: string, cachedOnly = false) => {
      if (cachedOnly) return Promise.resolve(listing([], false));
      refreshes += 1;
      return refreshes === 1 ? first.promise : second.promise;
    }),
  };

  const staleApply = vi.fn();
  const stale = loadPacks(commands, '!room:example.org', staleApply);
  await vi.waitFor(() => {
    expect(commands.imagePackListing).toHaveBeenCalledTimes(2);
  });
  invalidatePacks(commands);
  first.resolve(listing(cached));
  await vi.waitFor(() => {
    expect(commands.imagePackListing).toHaveBeenCalledTimes(4);
  });
  second.resolve(listing(fresh));
  await stale;
  expect(staleApply).toHaveBeenCalledExactlyOnceWith(fresh);

  const apply = vi.fn();
  await loadPacks(commands, '!room:example.org', apply);
  expect(apply).toHaveBeenCalledExactlyOnceWith(fresh);
});

test('shares a full refresh between concurrent picker mounts', async () => {
  const refresh = Promise.withResolvers<Listing>();
  const commands = {
    imagePackListing: vi.fn((_room: string, cachedOnly = false) =>
      cachedOnly ? Promise.resolve(listing([], false)) : refresh.promise
    ),
  };
  const first = vi.fn();
  const second = vi.fn();

  const loading = Promise.all([
    loadPacks(commands, '!room:example.org', first),
    loadPacks(commands, '!room:example.org', second),
  ]);
  await vi.waitFor(() => {
    expect(commands.imagePackListing).toHaveBeenCalledTimes(3);
  });
  refresh.resolve(listing(cached));
  await loading;

  expect(commands.imagePackListing).toHaveBeenLastCalledWith('!room:example.org');
  expect(first).toHaveBeenLastCalledWith(cached);
  expect(second).toHaveBeenLastCalledWith(cached);
});

test('offline refresh keeps the cached packs visible', async () => {
  const apply = vi.fn();
  const commands = {
    imagePackListing: vi.fn((_room: string, cachedOnly = false) =>
      cachedOnly ? Promise.resolve(listing(cached, false)) : Promise.reject(new Error('offline'))
    ),
  };
  await loadPacks(commands, '!room:example.org', apply);
  expect(apply).toHaveBeenCalledExactlyOnceWith(cached);
});

test('a failed cache read still allows the complete online result', async () => {
  const apply = vi.fn();
  const commands = {
    imagePackListing: vi.fn((_room: string, cachedOnly = false) =>
      cachedOnly ? Promise.reject(new Error('store unavailable')) : Promise.resolve(listing(cached))
    ),
  };
  await loadPacks(commands, '!room:example.org', apply);
  expect(apply).toHaveBeenCalledExactlyOnceWith(cached);
});

test('a failed refresh without cached packs is reported', async () => {
  const apply = vi.fn();
  const commands = {
    imagePackListing: vi.fn((_room: string, cachedOnly = false) =>
      cachedOnly ? Promise.resolve(listing([], false)) : Promise.reject(new Error('offline'))
    ),
  };
  await expect(loadPacks(commands, '!room:example.org', apply)).rejects.toThrow('offline');
  expect(apply).not.toHaveBeenCalled();
});

test('shows a stale snapshot at once and revalidates it', async () => {
  const now = vi.spyOn(Date, 'now').mockReturnValue(0);
  const fresh: ImagePackView[] = [{ ...cached[0], id: 'fresh' }];
  let refreshes = 0;
  const commands = {
    imagePackListing: vi.fn((_room: string, cachedOnly = false) => {
      if (cachedOnly) return Promise.resolve(listing([], false));
      refreshes += 1;
      return Promise.resolve(listing(refreshes === 1 ? cached : fresh));
    }),
  };

  await loadPacks(commands, '!room:example.org', vi.fn());
  now.mockReturnValue(10 * 60_000);
  const apply = vi.fn();
  await loadPacks(commands, '!room:example.org', apply);
  now.mockRestore();

  expect(commands.imagePackListing).toHaveBeenCalledTimes(3);
  expect(apply).toHaveBeenNthCalledWith(1, cached);
  expect(apply).toHaveBeenLastCalledWith(fresh);
});

test('reports whether the listing it applied was complete', async () => {
  let refreshes = 0;
  const commands = {
    imagePackListing: vi.fn((_room: string, cachedOnly = false) => {
      if (cachedOnly) return Promise.resolve(listing(cached, false));
      refreshes += 1;
      return refreshes === 1
        ? Promise.reject(new Error('offline'))
        : Promise.resolve(listing(cached, refreshes === 3));
    }),
  };

  await expect(loadPacks(commands, '!room:example.org', vi.fn())).resolves.toBe(false);
  await expect(loadPacks(commands, '!room:example.org', vi.fn())).resolves.toBe(false);
  await expect(loadPacks(commands, '!room:example.org', vi.fn())).resolves.toBe(true);
  await expect(loadPacks(commands, '!room:example.org', vi.fn())).resolves.toBe(true);
  expect(refreshes).toBe(3);
});
