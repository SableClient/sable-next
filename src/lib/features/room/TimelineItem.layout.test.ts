import { readFileSync } from 'node:fs';

import { expect, test } from 'vitest';

const source = readFileSync(new URL('./TimelineItem.svelte', import.meta.url), 'utf8');

test('keeps read receipts below the message instead of taking its text column', () => {
  const content = source.match(/\.message-content \{(?<body>[^}]+)\}/u)?.groups?.body;
  const receipts = source.match(
    /\.message-content > :global\(\.read-receipt-stack\) \{(?<body>[^}]+)\}/u
  )?.groups?.body;

  expect(content).toContain('grid-template-columns: minmax(0, 1fr);');
  expect(receipts).toContain('grid-column: 1;');
  expect(receipts).not.toContain('margin-inline-start');
});
