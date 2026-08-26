import { expect, test, vi } from 'vitest';

import { RoomNameWriter } from './room-names.js';

test('writes each name once and skips names that have not changed', async () => {
  const write = vi.fn(() => Promise.resolve());
  const writer = new RoomNameWriter(write, 0);

  writer.remember(new Map([['!a', 'Alpha']]));
  await writer.flush();
  writer.remember(new Map([['!a', 'Alpha']]));
  await writer.flush();

  expect(write).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledWith(new Map([['!a', 'Alpha']]));
});

test('a renamed room is written again, alone', async () => {
  const write = vi.fn(() => Promise.resolve());
  const writer = new RoomNameWriter(write, 0);

  writer.remember(
    new Map([
      ['!a', 'Alpha'],
      ['!b', 'Beta'],
    ])
  );
  await writer.flush();
  writer.remember(
    new Map([
      ['!a', 'Alpha'],
      ['!b', 'Beta renamed'],
    ])
  );
  await writer.flush();

  expect(write).toHaveBeenLastCalledWith(new Map([['!b', 'Beta renamed']]));
});

test('a burst of diffs collapses into one write', async () => {
  vi.useFakeTimers();
  const write = vi.fn(() => Promise.resolve());
  const writer = new RoomNameWriter(write, 1000);

  writer.remember(new Map([['!a', 'Alpha']]));
  writer.remember(new Map([['!b', 'Beta']]));
  writer.remember(new Map([['!c', 'Gamma']]));

  expect(write).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1000);

  expect(write).toHaveBeenCalledTimes(1);
  expect(write).toHaveBeenCalledWith(
    new Map([
      ['!a', 'Alpha'],
      ['!b', 'Beta'],
      ['!c', 'Gamma'],
    ])
  );
  vi.useRealTimers();
});

test('a failed write is retried rather than dropped', async () => {
  const write = vi
    .fn<(names: ReadonlyMap<string, string>) => Promise<void>>()
    .mockRejectedValueOnce(new Error('storage unavailable'))
    .mockResolvedValueOnce();
  const writer = new RoomNameWriter(write, 0);

  writer.remember(new Map([['!a', 'Alpha']]));
  await writer.flush();
  await writer.flush();

  expect(write).toHaveBeenCalledTimes(2);
  expect(write).toHaveBeenLastCalledWith(new Map([['!a', 'Alpha']]));
});

test('disposing drops a scheduled write', async () => {
  vi.useFakeTimers();
  const write = vi.fn(() => Promise.resolve());
  const writer = new RoomNameWriter(write, 1000);

  writer.remember(new Map([['!a', 'Alpha']]));
  writer.dispose();
  await vi.advanceTimersByTimeAsync(1000);

  expect(write).not.toHaveBeenCalled();
  vi.useRealTimers();
});
