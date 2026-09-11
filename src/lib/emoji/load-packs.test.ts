import { expect, test, vi } from 'vitest';
import type { ImagePackView } from '#src/generated/protocol';
import { loadPacks } from './load-packs';

const cached: ImagePackView[] = [
  {
    id: 'cached',
    origin: 'room',
    room_id: '!room:example.org',
    name: null,
    avatar_url: null,
    attribution: null,
    images: [],
  },
];

test('cached packs are available while the full state request remains pending', async () => {
  const refresh = Promise.withResolvers<ImagePackView[]>();
  const commands = {
    imagePacks: vi.fn((_room: string, cachedOnly = false) =>
      cachedOnly ? Promise.resolve(cached) : refresh.promise
    ),
  };
  const apply = vi.fn();
  const loading = loadPacks(commands, '!room:example.org', apply);
  await vi.waitFor(() => {
    expect(apply).toHaveBeenCalledExactlyOnceWith(cached);
  });
  expect(commands.imagePacks).toHaveBeenLastCalledWith('!room:example.org');
  refresh.resolve([]);
  await loading;
  expect(apply).toHaveBeenLastCalledWith([]);
});

test('offline refresh keeps the cached packs visible', async () => {
  const apply = vi.fn();
  const commands = {
    imagePacks: vi.fn((_room: string, cachedOnly = false) =>
      cachedOnly ? Promise.resolve(cached) : Promise.reject(new Error('offline'))
    ),
  };
  await loadPacks(commands, '!room:example.org', apply);
  expect(apply).toHaveBeenCalledExactlyOnceWith(cached);
});

test('a failed cache read still allows the complete online result', async () => {
  const apply = vi.fn();
  const commands = {
    imagePacks: vi.fn((_room: string, cachedOnly = false) =>
      cachedOnly ? Promise.reject(new Error('store unavailable')) : Promise.resolve(cached)
    ),
  };
  await loadPacks(commands, '!room:example.org', apply);
  expect(apply).toHaveBeenCalledExactlyOnceWith(cached);
});

test('a failed refresh without cached packs is reported', async () => {
  const apply = vi.fn();
  const commands = {
    imagePacks: vi.fn((_room: string, cachedOnly = false) =>
      cachedOnly ? Promise.resolve([]) : Promise.reject(new Error('offline'))
    ),
  };
  await expect(loadPacks(commands, '!room:example.org', apply)).rejects.toThrow('offline');
  expect(apply).not.toHaveBeenCalled();
});
