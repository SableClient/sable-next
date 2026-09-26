import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const nativeDateInput = /type\s*=\s*["'{`]*(?:date|time|datetime-local|month|week)["'}`]/g;

function svelteFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return svelteFiles(path);
    return entry.name.endsWith('.svelte') ? [path] : [];
  });
}

const files = svelteFiles('src');
const failures = files.flatMap((file) => {
  const text = readFileSync(file, 'utf8');
  return [...text.matchAll(nativeDateInput)].map(
    (match) =>
      `${file}:${text.slice(0, match.index).split('\n').length}: a native date or time input ignores the Time & Date settings; use DateTimeField`
  );
});
if (failures.length) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.log(`No native date or time inputs in ${String(files.length)} components.`);
}
