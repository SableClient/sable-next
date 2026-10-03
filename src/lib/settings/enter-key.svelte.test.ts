import { afterEach, expect, test, vi } from 'vitest';

const pointer = vi.hoisted(() => ({ coarse: false }));

vi.mock('#lib/ui/media-query.svelte.js', () => ({
  createMediaQuery: () => ({
    get matches() {
      return pointer.coarse;
    },
  }),
}));

import { enterInsertsNewline } from './enter-key.svelte.js';
import { preferences } from './preferences.svelte.js';

afterEach(() => {
  preferences.enterForNewline = 'adaptive';
});

test.each([
  ['adaptive', true, true],
  ['adaptive', false, false],
  ['newline', false, true],
  ['send', true, false],
] as const)('%s with a coarse pointer=%s inserts a newline=%s', (mode, coarse, expected) => {
  pointer.coarse = coarse;
  preferences.enterForNewline = mode;
  expect(enterInsertsNewline()).toBe(expected);
});
