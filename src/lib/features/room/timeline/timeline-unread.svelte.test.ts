import { expect, test, vi } from 'vitest';
import type { TimelineItemView } from '#src/generated/protocol';
import { TimelineUnread } from './timeline-unread.svelte.js';

function message(id: string, own = false): TimelineItemView {
  return { id, event_id: `$${id}`, is_own: own, content: { kind: 'message' } } as TimelineItemView;
}
function marker(): TimelineItemView {
  return { id: 'marker', event_id: null, content: { kind: 'read_marker' } } as TimelineItemView;
}

test('landing below the unread boundary holds receipts until its first message is seen', async () => {
  const unread = new TimelineUnread();
  const items = [
    message('read'),
    marker(),
    message('own', true),
    message('first'),
    message('later'),
  ];
  await unread.initialize(items, true);
  expect(unread.firstEventId).toBe('$first');
  expect(unread.count(items)).toBe(2);
  unread.observe('$later');
  expect(unread.blocking).toBe(true);
  unread.observe('$first');
  expect(unread.blocking).toBe(false);
  unread.resolve(
    [message('read'), message('own', true), message('first'), marker(), message('later')],
    false
  );
  expect(unread.firstEventId).toBe('$first');
});

test('resolves an unloaded boundary after history arrives and skips hidden events', async () => {
  const unread = new TimelineUnread();
  const hidden = { ...message('hidden'), content: { kind: 'membership' } } as TimelineItemView;
  const load = vi.fn().mockResolvedValue('$read');
  await unread.initialize([message('later')], true, load);
  unread.resolve([message('later')], false);
  expect(unread.blocking).toBe(true);
  expect(unread.firstEventId).toBeNull();
  unread.resolve(
    [message('read'), hidden, message('own', true), message('first'), message('later')],
    false
  );
  expect(unread.firstEventId).toBe('$first');
  expect(load).toHaveBeenCalledTimes(1);
});

test('a room without a read marker starts from its oldest visible unread message', async () => {
  const unread = new TimelineUnread();
  await unread.initialize([message('later')], true, () => Promise.resolve(null));
  unread.resolve([message('later')], false);
  expect(unread.firstEventId).toBeNull();
  unread.resolve([message('first'), message('later')], true);
  expect(unread.firstEventId).toBe('$first');
});

test('a failed marker lookup keeps receipts blocked and can be retried', async () => {
  const unread = new TimelineUnread();
  const load = vi.fn().mockRejectedValueOnce(new Error('offline')).mockResolvedValue('$read');
  await unread.initialize([message('later')], true, load);
  unread.resolve([message('later')], true);
  expect(unread.blocking).toBe(true);
  expect(unread.failed).toBe(true);
  await unread.initialize([message('read'), message('first')], false, load);
  unread.resolve([message('read'), message('first')], false);
  expect(unread.firstEventId).toBe('$first');
  expect(unread.failed).toBe(false);
});

test('a read boundary already at the latest event needs no history or unread bar', async () => {
  const unread = new TimelineUnread();
  await unread.initialize([message('latest')], true, () => Promise.resolve('$latest'));
  unread.resolve([message('latest')], false);
  expect(unread.active).toBe(false);
  expect(unread.blocking).toBe(false);
});

test('dismissing while a marker lookup is in flight cannot restore the unread state', async () => {
  const unread = new TimelineUnread();
  let resolve!: (eventId: string) => void;
  const loading = unread.initialize(
    [message('later')],
    true,
    () =>
      new Promise((done) => {
        resolve = done;
      })
  );
  unread.dismiss();
  resolve('$read');
  await loading;
  unread.resolve([message('read'), message('first')], false);
  expect(unread.active).toBe(false);
  expect(unread.blocking).toBe(false);
});

test('a fully-read event hidden by preferences still defines the unread boundary', async () => {
  const unread = new TimelineUnread();
  const hiddenRead = { ...message('read'), content: { kind: 'membership' } } as TimelineItemView;
  const raw = [message('old'), hiddenRead, message('first'), message('later')];
  const visible = [raw[0], raw[2], raw[3]];
  await unread.initialize(raw, true, () => Promise.resolve('$read'), visible);
  unread.resolve(raw, false, visible);
  expect(unread.firstEventId).toBe('$first');
  expect(unread.count(visible)).toBe(2);
});

test('redacting a hidden unread target advances the jump to its next visible message', async () => {
  const unread = new TimelineUnread();
  await unread.initialize([marker(), message('first'), message('next')], true);
  const redacted = { ...message('first'), content: { kind: 'redacted' } } as TimelineItemView;
  unread.resolve([marker(), redacted, message('next')], false, [marker(), message('next')]);
  expect(unread.firstEventId).toBe('$next');
  expect(unread.blocking).toBe(true);
});

test('reaching the latest message unblocks receipts even when the marker lookup failed', async () => {
  const unread = new TimelineUnread();
  await unread.initialize([message('later')], true, () => Promise.reject(new Error('offline')));
  expect(unread.failed).toBe(true);
  expect(unread.blocking).toBe(true);
  unread.reachLatest();
  expect(unread.blocking).toBe(false);
});

test('keeps the first background message as the unread target', async () => {
  const unread = new TimelineUnread();
  const items = [message('read')];
  await unread.initialize(items, false);
  unread.trackBackground(items, true);
  items.push(message('own', true), message('first'), message('later'));
  unread.trackBackground(items, false);
  expect(unread.firstEventId).toBe('$first');
  expect(unread.readEventId).toBe('$read');
  expect(unread.count(items)).toBe(2);
  expect(unread.background).toBe(true);
  expect(unread.blocking).toBe(true);

  items.push(message('latest'));
  unread.trackBackground(items, false);
  unread.trackBackground(items, true);
  expect(unread.firstEventId).toBe('$first');
  expect(unread.blocking).toBe(true);
  unread.observe('$first');
  expect(unread.background).toBe(false);
  expect(unread.blocking).toBe(false);
});

test('ignores history, own messages and foreground arrivals', async () => {
  const unread = new TimelineUnread();
  await unread.initialize([message('read')], false);
  unread.trackBackground([message('read')], true);
  unread.trackBackground([message('history'), message('read')], false);
  unread.trackBackground([message('read'), message('own', true)], false);
  unread.trackBackground([message('read'), message('own', true), message('latest')], true);
  expect(unread.active).toBe(false);
  expect(unread.background).toBe(false);
});

test('preserves an existing unread target in the background', async () => {
  const unread = new TimelineUnread();
  const items = [marker(), message('first'), message('read')];
  await unread.initialize(items, true);
  unread.observe('$first');
  unread.trackBackground(items, true);
  items.push(message('missed'));
  unread.trackBackground(items, false);
  expect(unread.firstEventId).toBe('$first');
  expect(unread.background).toBe(true);
  expect(unread.blocking).toBe(true);
});

test('starts a new unread target after reading the first batch', async () => {
  const unread = new TimelineUnread();
  const items = [message('read')];
  await unread.initialize(items, false);
  unread.trackBackground(items, true);
  items.push(message('first'));
  unread.trackBackground(items, false);
  unread.reachLatest();
  unread.dismiss();
  expect(unread.background).toBe(false);
  items.push(message('second'));
  unread.trackBackground(items, false);
  expect(unread.firstEventId).toBe('$second');
  expect(unread.readEventId).toBe('$first');
  expect(unread.blocking).toBe(true);
});
