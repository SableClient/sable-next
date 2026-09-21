import { readFileSync } from 'node:fs';

import { expect, test } from 'vitest';

const source = readFileSync(new URL('./ComposerContextBanner.svelte', import.meta.url), 'utf8');

test('a long reply sender leaves room for the context actions', () => {
  const contextKind = source.match(/\.context-kind \{(?<contents>[^}]+)\}/u)?.groups?.contents;

  expect(contextKind).toContain('flex: 0 1 auto;');
  expect(contextKind).toContain('min-width: 0;');
  expect(contextKind).toContain('overflow: hidden;');
  expect(contextKind).toContain('text-overflow: ellipsis;');
  expect(contextKind).toContain('white-space: nowrap;');
});
