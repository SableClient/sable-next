import { readFileSync } from 'node:fs';

import { expect, test } from 'vitest';

/**
 * `followOnAppend` makes the virtualiser call its own `scrollToEnd`, which arms
 * `reconcileScroll` to force the virtualiser's target back for five seconds,
 * recomputed against the live viewport. A viewport that shrinks inside that
 * window — the composer growing a reply banner — is sent to the top of the room.
 *
 * It has been removed once before and came back. This asserts on the source
 * because the option is passed in two places and only takes effect at runtime.
 */
test('the virtualiser never follows appends on its own', () => {
  const source = readFileSync(new URL('./TimelineList.svelte', import.meta.url), 'utf8');
  const settings = source.match(/followOnAppend: (\w+)/g);

  expect(settings).toEqual(['followOnAppend: false', 'followOnAppend: false']);
});
