import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildChanges, diffSettings, parseSettings } from './settings-changes.mjs';

const source = (keys, defaults) => [
  {
    path: 'registry/a.ts',
    text: `export const items = [${keys.map((key) => `{ key: '${key}', name: 'n' }`)}]`,
  },
  { path: 'preferences.svelte.ts', text: `const DEFAULTS: Preferences = { ${defaults} }` },
];

test('parses registry keys and default initializers', () => {
  assert.deepEqual(parseSettings(source(['a', 'b'], "a: true, b: 'x', c: foo()")), {
    keys: ['a', 'b'],
    defaults: { a: 'true', b: "'x'", c: 'foo()' },
  });
});

test('reports added keys and changed defaults but not unchanged ones', () => {
  const before = parseSettings(source(['a', 'b', 'c'], "a: true, b: 'x', c: 1"));
  const after = parseSettings(source(['a', 'b', 'c', 'd'], "a: false, b: 'x', c: 1, d: 2"));
  assert.deepEqual(diffSettings(before, after), {
    added: ['d'],
    changed: [{ key: 'a', from: 'true', to: 'false' }],
  });
});

test('does not report a default change for a setting that was not registered before', () => {
  const before = parseSettings(source([], 'a: 1'));
  const after = parseSettings(source(['a'], 'a: 2'));
  assert.deepEqual(diffSettings(before, after), { added: ['a'], changed: [] });
});

test('diffs the upcoming and last two releases and skips empty ones', () => {
  const revisions = {
    'v1.0.0': parseSettings(source(['a'], 'a: 1')),
    'v1.1.0': parseSettings(source(['a', 'b'], 'a: 1, b: 1')),
    'v1.2.0': parseSettings(source(['a', 'b'], 'a: 1, b: 1')),
    head: parseSettings(source(['a', 'b', 'c'], 'a: 1, b: 2, c: 1')),
  };
  const changes = buildChanges(
    ['v0.9.0', 'v1.0.0', 'v1.1.0', 'v1.2.0'],
    (rev) => revisions[rev ?? 'head']
  );
  assert.deepEqual(changes, {
    upcoming: { added: ['c'], changed: [{ key: 'b', from: '1', to: '2' }] },
    'v1.1.0': { added: ['b'], changed: [] },
  });
});
