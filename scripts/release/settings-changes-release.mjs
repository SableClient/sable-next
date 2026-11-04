import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

// The release job installs no packages, so this must not import the TypeScript-based generator.

export const root = join(import.meta.dirname, '../..');
export const output = join(root, 'src/generated/settings-changes.json');
export const releaseCount = 2;

export function git(...args) {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export function releaseTags() {
  let list;
  try {
    list = git('tag', '--list', '--merged', 'HEAD', 'v*');
  } catch {
    return [];
  }
  return list
    .split('\n')
    .filter((tag) => /^v\d+\.\d+\.\d+$/.test(tag))
    .sort((a, b) => {
      const [x, y] = [a, b].map((tag) => tag.slice(1).split('.').map(Number));
      return x[0] - y[0] || x[1] - y[1] || x[2] - y[2];
    });
}

export function releaseChanges(changes, version, tags) {
  const tag = `v${version}`;
  const kept = new Set([...tags, tag].slice(-releaseCount));
  const { upcoming, ...released } = changes;
  const result = upcoming ? { [tag]: upcoming } : {};
  for (const [name, section] of Object.entries(released)) {
    if (kept.has(name)) result[name] = section;
  }
  return result;
}

if (import.meta.main) {
  const version = process.argv[2];
  if (!/^\d+\.\d+\.\d+$/.test(version ?? '')) {
    console.error(`Usage: settings-changes-release.mjs <version>  (got: ${version ?? '<none>'})`);
    process.exit(1);
  }
  const changes = JSON.parse(readFileSync(output, 'utf8'));
  const released = releaseChanges(changes, version, releaseTags());
  writeFileSync(output, `${JSON.stringify(released, null, 2)}\n`);
}
