import { expect, test } from 'vitest';

import { MatrixKeyProvider } from './key-provider';

test('failed decryptions never mark a participant key invalid', () => {
  expect(new MatrixKeyProvider().getOptions().failureTolerance).toBe(-1);
});
