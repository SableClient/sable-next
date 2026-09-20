import { expect, test } from 'vitest';

import { preferences, sanitize } from './preferences.svelte.js';

test('keeps the cached loading animal', () => {
  expect(sanitize({ loadingAnimal: 'otter' }, preferences).loadingAnimal).toBe('otter');
});
