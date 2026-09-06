import { readFileSync } from 'node:fs';

const source = 'src/lib/features/room/TimelineList.svelte';
const text = readFileSync(source, 'utf8');
const forbidden = [
  {
    pattern: /@tanstack\/svelte-virtual/g,
    reason: 'the timeline window owns rendering and anchoring',
  },
  {
    pattern: /\.scrollTop\s*(?:[+-]=|=(?!=))/g,
    reason: 'scroll offsets belong to TimelineWindow',
  },
  { pattern: /\.scroll(?:To|By)\s*\(/g, reason: 'scroll commands belong to TimelineWindow' },
];
const failures = forbidden.flatMap(({ pattern, reason }) =>
  [...text.matchAll(pattern)].map(
    (match) => `${source}:${text.slice(0, match.index).split('\n').length}: ${reason}`
  )
);
if (!text.includes('historyController.observeScroll(')) {
  failures.push(
    'History pagination must observe reader movement, including scrollbar and momentum scrolling.'
  );
}
if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.log('TimelineWindow owns timeline scrolling.');
}
