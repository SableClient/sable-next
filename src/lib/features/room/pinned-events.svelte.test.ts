import { expect, test, vi } from 'vitest';

import { PinnedEvents, type PinnedEventCommands } from './pinned-events.svelte.js';

function fakeCore(pinnedEvents = vi.fn(() => Promise.resolve<string[]>([])), setPinned = vi.fn()) {
  return { pinnedEvents, setPinned } as unknown as PinnedEventCommands;
}

test('one load answers for every event in the room', async () => {
  const pinnedEvents = vi.fn(() => Promise.resolve(['$a', '$b']));
  const pins = new PinnedEvents(fakeCore(pinnedEvents));

  await pins.load('!room:example.org');

  expect(pinnedEvents).toHaveBeenCalledTimes(1);
  expect(pins.has('$a')).toBe(true);
  expect(pins.has('$b')).toBe(true);
  expect(pins.has('$c')).toBe(false);
  expect(pins.has(null)).toBe(false);
});

test('toggling updates the shared set without another fetch', async () => {
  const pinnedEvents = vi.fn(() => Promise.resolve(['$a']));
  const setPinned = vi.fn(() => Promise.resolve(['$a', '$b']));
  const pins = new PinnedEvents(fakeCore(pinnedEvents, setPinned));

  await pins.load('!room:example.org');
  await pins.toggle('!room:example.org', '$b');

  expect(setPinned).toHaveBeenCalledWith('!room:example.org', '$b', true);
  expect(pins.has('$b')).toBe(true);
  expect(pinnedEvents).toHaveBeenCalledTimes(1);
});

test('unpinning passes the current state through', async () => {
  const setPinned = vi.fn(() => Promise.resolve<string[]>([]));
  const pins = new PinnedEvents(
    fakeCore(
      vi.fn(() => Promise.resolve(['$a'])),
      setPinned
    )
  );

  await pins.load('!room:example.org');
  await pins.toggle('!room:example.org', '$a');

  expect(setPinned).toHaveBeenCalledWith('!room:example.org', '$a', false);
  expect(pins.has('$a')).toBe(false);
});

test('a slow load for the previous room cannot overwrite the current one', async () => {
  let release: (ids: string[]) => void = () => {};
  const pinnedEvents = vi
    .fn()
    .mockImplementationOnce(() => new Promise<string[]>((resolve) => (release = resolve)))
    .mockImplementationOnce(() => Promise.resolve(['$new']));
  const pins = new PinnedEvents(fakeCore(pinnedEvents));

  const stale = pins.load('!old:example.org');
  await pins.load('!new:example.org');
  release(['$old']);
  await stale;

  expect(pins.has('$new')).toBe(true);
  expect(pins.has('$old')).toBe(false);
});

test('a slow toggle for the previous room cannot overwrite the current one', async () => {
  let release: (ids: string[]) => void = () => {};
  const setPinned = vi.fn(() => new Promise<string[]>((resolve) => (release = resolve)));
  const pins = new PinnedEvents(
    fakeCore(
      vi.fn(() => Promise.resolve(['$new'])),
      setPinned
    )
  );

  const stale = pins.toggle('!old:example.org', '$old');
  await pins.load('!new:example.org');
  release(['$old']);
  await stale;

  expect(pins.has('$new')).toBe(true);
  expect(pins.has('$old')).toBe(false);
});

test('a failed load leaves the set intact rather than clearing it', async () => {
  const pinnedEvents = vi
    .fn()
    .mockImplementationOnce(() => Promise.resolve(['$a']))
    .mockImplementationOnce(() => Promise.reject(new Error('offline')));
  const pins = new PinnedEvents(fakeCore(pinnedEvents));

  await pins.load('!room:example.org');
  await pins.load('!room:example.org');

  expect(pins.has('$a')).toBe(true);
});
