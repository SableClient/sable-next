import { expect, test } from 'vitest';

import { variantAvailable } from './variants.js';

test('only the ceo tier unlocks the ceo variant', () => {
  expect(variantAvailable('ceo', 'ceo')).toBe(true);
  expect(variantAvailable('ceo', 'patron')).toBe(false);
  expect(variantAvailable('ceo', null)).toBe(false);
});
