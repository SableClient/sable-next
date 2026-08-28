import { readFileSync } from 'node:fs';

const source = 'src/lib/features/room/TimelineList.svelte';
const text = readFileSync(source, 'utf8');

const required = [
  { option: 'anchorTo', value: "'start'" },
  { option: 'followOnAppend', value: 'false' },
  { option: 'scrollEndThreshold', value: '0' },
];

const forbidden = [
  {
    label: 'virtualizer.measure()',
    pattern: /(?<![A-Za-z])measure\(\)/g,
    reason:
      'clears the whole itemSizeCache, and a rendered row only re-measures on a real resize, so every row falls back to estimateSize and overlaps the next',
  },
];

const failures = [];
for (const { option, value } of required) {
  const found = [...text.matchAll(new RegExp(`^\\s*${option}:\\s*(.+?),\\s*$`, 'gm'))];
  if (found.length === 0) {
    failures.push(`${option} is not set; the virtualiser falls back to its own default`);
    continue;
  }
  for (const match of found) {
    if (match[1] === value) continue;
    const line = text.slice(0, match.index).split('\n').length;
    failures.push(`${source}:${line} ${option} is ${match[1]}, must be ${value}`);
  }
}

for (const { label, pattern, reason } of forbidden) {
  for (const match of text.matchAll(pattern)) {
    const line = text.slice(0, match.index).split('\n').length;
    failures.push(`${source}:${line} calls ${label}, which ${reason}`);
  }
}

if (failures.length > 0) {
  console.error('The timeline virtualiser must not own the scroll offset:');
  for (const failure of failures) console.error(`  ${failure}`);
  console.error("  `anchorTo: 'end'` writes the virtualiser's cached offset back to the DOM on");
  console.error('  any edge-key change, and short-circuits');
  console.error('  shouldAdjustScrollPositionOnItemSizeChange inside scrollEndThreshold.');
  console.error('  TimelineAnchor is the sole owner. See .claude/CLAUDE.md.');
  process.exitCode = 1;
} else {
  console.log(
    `Timeline virtualiser owns no scroll offset; ${required.length} options pinned, ${forbidden.length} call forbidden.`
  );
}
