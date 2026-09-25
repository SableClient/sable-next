import { readFileSync } from 'node:fs';

import { expect, test } from 'vitest';

const threadPanel = readFileSync(new URL('../room/ThreadPanel.svelte', import.meta.url), 'utf8');
const timeline = readFileSync(new URL('../room/TimelineList.svelte', import.meta.url), 'utf8');

test('allows a forum thread timeline to shrink to its panel width', () => {
  const panel = threadPanel.match(/\.thread-panel \{(?<body>[^}]+)\}/u)?.groups?.body;
  const composer = threadPanel.match(/\.thread-composer \{(?<body>[^}]+)\}/u)?.groups?.body;
  const content = timeline.match(/\.timeline-content \{(?<body>[^}]+)\}/u)?.groups?.body;
  const stage = timeline.match(/\.timeline-stage \{(?<body>[^}]+)\}/u)?.groups?.body;
  const items = timeline.match(/\.items \{(?<body>[^}]+)\}/u)?.groups?.body;

  expect(panel).toContain('min-width: 0;');
  expect(composer).toContain('min-width: 0;');
  expect(content).toContain('min-width: 0;');
  expect(stage).toContain('min-width: 0;');
  expect(items).toContain('min-width: 0;');
});
