import { expect, test } from 'vitest';

import { automaticMediaRetryDelay, mediaRetryDelay } from './media-retry.js';

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
