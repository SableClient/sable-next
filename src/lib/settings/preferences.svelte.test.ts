import { expect, test } from 'vitest';

import { preferences } from './preferences.svelte.js';

test('pronoun pills are shown until the reader hides them', () => {
  expect(preferences.hidePronounPill).toBe(false);
});
