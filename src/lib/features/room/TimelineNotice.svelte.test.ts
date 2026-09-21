import { readFileSync } from 'node:fs';

import { expect, test } from 'vitest';

const source = readFileSync(new URL('./TimelineNotice.svelte', import.meta.url), 'utf8');

test('uses the regular message type scale for state events', () => {
  const stateRule = source.match(/\.state \{(?<contents>[^}]+)\}/u)?.groups?.contents;

  expect(stateRule).toContain('font-size: var(--font-size-body);');
  expect(stateRule).toContain('line-height: var(--line-height-body);');
});
