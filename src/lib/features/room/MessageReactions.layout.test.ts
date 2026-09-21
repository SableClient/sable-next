import { readFileSync } from 'node:fs';

import { expect, test } from 'vitest';

const source = readFileSync(new URL('./MessageReactions.svelte', import.meta.url), 'utf8');

test('reaction contents are centered in their pill', () => {
  const reactionRule = source.match(/\.reaction \{(?<contents>[^}]+)\}/u)?.groups?.contents;

  expect(reactionRule).toContain('align-items: center;');
});
