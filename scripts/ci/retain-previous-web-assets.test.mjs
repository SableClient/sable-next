import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mergeRetained } from './retain-previous-web-assets.mjs';

const now = new Date('2026-10-10T00:00:00Z');

test('keeps a recent previous asset and refreshes a current one', () => {
  const { files, carry } = mergeRetained(
    {
      '_app/immutable/chunks/old.js': '2026-10-08T00:00:00.000Z',
      '_app/immutable/chunks/same.js': '2026-10-01T00:00:00.000Z',
    },
    ['_app/immutable/chunks/same.js', '_app/immutable/chunks/new.js'],
    now
  );

  assert.deepEqual(carry, ['_app/immutable/chunks/old.js']);
  assert.equal(files['_app/immutable/chunks/old.js'], '2026-10-08T00:00:00.000Z');
  assert.equal(files['_app/immutable/chunks/same.js'], now.toISOString());
});

test('drops assets past the age limit', () => {
  const { files, carry } = mergeRetained(
    { '_app/immutable/chunks/stale.js': '2026-10-01T00:00:00.000Z' },
    [],
    now
  );

  assert.deepEqual(carry, []);
  assert.deepEqual(files, {});
});

test('refuses paths outside the immutable directory', () => {
  const { carry } = mergeRetained(
    {
      'index.html': '2026-10-09T00:00:00.000Z',
      '_app/immutable/../../etc/passwd': '2026-10-09T00:00:00.000Z',
    },
    [],
    now
  );

  assert.deepEqual(carry, []);
});
