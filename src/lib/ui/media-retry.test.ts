import { expect, test } from 'vitest';

import { automaticMediaRetryDelay, mediaFailureHold, mediaRetryDelay } from './media-retry.js';

test('caps media retry backoff at sixteen seconds', () => {
  expect([1, 2, 3, 4, 5].map(mediaRetryDelay)).toEqual([2_000, 4_000, 8_000, 16_000, 16_000]);
});

test('limits automatic media retries to four attempts', () => {
  expect([1, 2, 3, 4, 5].map(automaticMediaRetryDelay)).toEqual([
    2_000,
    4_000,
    8_000,
    16_000,
    null,
  ]);
});

test('holds a failed source as long as the component waits to retry it, then keeps doubling', () => {
  expect([1, 2, 3, 4].map(mediaFailureHold)).toEqual([1, 2, 3, 4].map(mediaRetryDelay));
  expect([5, 6, 7].map(mediaFailureHold)).toEqual([32_000, 64_000, 128_000]);
});

test('stops growing the hold at ten minutes', () => {
  expect([10, 20, 1_000].map(mediaFailureHold)).toEqual([600_000, 600_000, 600_000]);
});
