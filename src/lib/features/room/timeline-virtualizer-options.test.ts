import { readFileSync } from 'node:fs';

import { expect, test } from 'vitest';

/**
 * `followOnAppend` arms `reconcileScroll`, which forces the virtualiser's target
 * back for five seconds against the live viewport, so a shrink inside that window
 * sends the reader to the top. It has been removed once before and came back;
 * the option is set in two places and only takes effect at runtime.
 */
test('the virtualiser never follows appends on its own', () => {
  const source = readFileSync(new URL('./TimelineList.svelte', import.meta.url), 'utf8');
  const settings = source.match(/followOnAppend: (\w+)/g);

  expect(settings).toEqual(['followOnAppend: false', 'followOnAppend: false']);
});
