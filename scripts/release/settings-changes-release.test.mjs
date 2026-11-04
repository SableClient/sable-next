import assert from 'node:assert/strict';
import { test } from 'node:test';
import { releaseChanges } from './settings-changes-release.mjs';

const section = (key) => ({ added: [key], changed: [] });

test('files the upcoming changes under the new release and keeps the previous one', () => {
  const changes = { upcoming: section('c'), 'v1.1.0': section('b'), 'v1.0.0': section('a') };
  assert.deepEqual(releaseChanges(changes, '1.2.0', ['v1.0.0', 'v1.1.0']), {
    'v1.2.0': section('c'),
    'v1.1.0': section('b'),
  });
});

test('a release without upcoming changes keeps only the releases still in the window', () => {
  const changes = { 'v1.1.0': section('b'), 'v1.0.0': section('a') };
  assert.deepEqual(releaseChanges(changes, '1.2.0', ['v1.0.0', 'v1.1.0']), {
    'v1.1.0': section('b'),
  });
});
