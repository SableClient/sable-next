import { expect, test } from 'vitest';

import { TimelineEventRouter } from './timeline-event-router';

test('buffers more than eight startup events and delivers them only to the claimed owner', () => {
  const router = new TimelineEventRouter<string>();
  const events = Array.from({ length: 10 }, (_, index) => ({
    type: 'timeline_pagination' as const,
    subscription: 1,
    loading: index % 2 === 0,
    reached_start: false,
  }));

  router.begin('first-tab');
  for (const event of events) expect(router.route(event)).toBeNull();
  expect(router.claim(1, 'first-tab')).toEqual(events);
  expect(router.route(events[0])).toBe('first-tab');
});

test('bounds events for an unknown subscription', () => {
  const router = new TimelineEventRouter<string>();
  router.begin('tab');
  for (let index = 0; index < 101; index += 1) {
    router.route({
      type: 'timeline_pagination',
      subscription: 1,
      loading: false,
      reached_start: false,
    });
  }

  expect(router.claim(1, 'tab')).toHaveLength(100);
});

test('isolates two owners and rejects unauthorized pagination or unsubscribe', () => {
  const router = new TimelineEventRouter<string>();
  router.begin('first-tab');
  router.claim(1, 'first-tab');
  router.begin('second-tab');
  router.claim(2, 'second-tab');

  expect(router.owns(1, 'second-tab')).toBe(false);
  expect(router.owns(2, 'second-tab')).toBe(true);
  expect(router.owns(1, 'first-tab')).toBe(true);

  // The worker uses owns() as the public authorization gate for both commands.
  expect(router.owns(2, 'first-tab')).toBe(false);
  expect(router.route({ type: 'timeline_diff', subscription: 1, diffs: [] })).toBe('first-tab');
  expect(router.route({ type: 'timeline_diff', subscription: 2, diffs: [] })).toBe('second-tab');
});

test('removes closed owners and does not activate their pending subscription', () => {
  const router = new TimelineEventRouter<string>();
  router.begin('first-tab');
  router.route({ type: 'timeline_diff', subscription: 1, diffs: [] });
  router.claim(2, 'first-tab');

  expect(router.removeOwner('first-tab')).toEqual([2]);
  expect(router.claim(1, 'first-tab')).toBeNull();
  expect(router.route({ type: 'timeline_diff', subscription: 2, diffs: [] })).toBeNull();
});

test('keeps pending requests independent from active subscriptions', () => {
  const router = new TimelineEventRouter<string>();
  router.begin('first-tab');
  expect(router.claim(1, 'first-tab')).toEqual([]);
  router.begin('first-tab');
  router.cancelPending('first-tab');

  expect(router.owns(1, 'first-tab')).toBe(true);
  expect(router.claim(2, 'first-tab')).toBeNull();
});

test('does not activate a subscription whose pending owner closed', () => {
  const router = new TimelineEventRouter<string>();
  router.begin('first-tab');
  expect(router.removeOwner('first-tab')).toEqual([]);

  expect(router.claim(1, 'first-tab')).toBeNull();
});

test('discards buffered startup events when the subscription command fails', () => {
  const router = new TimelineEventRouter<string>();
  const event = { type: 'timeline_diff' as const, subscription: 1, diffs: [] };

  router.begin('first-tab');
  router.route(event);
  router.cancelPending('first-tab');

  router.begin('second-tab');
  expect(router.claim(1, 'second-tab')).toEqual([]);
});
