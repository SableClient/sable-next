import assert from 'node:assert/strict';
import { test } from 'node:test';
import worker from '../../infra/web/worker.mjs';

const spa = new Response('<!doctype html>', { headers: { 'content-type': 'text/html' } });
const env = { ASSETS: { fetch: async () => spa } };
const get = (path) => worker.fetch(new Request(`https://app.sable.moe${path}`), env);

test('a missing hashed asset is a 404, not the app shell', async () => {
  for (const path of [
    '/_app/immutable/assets/NOPE.wasm',
    '/_app/immutable/chunks/old.js',
    '/_app/immutable/assets/old.css',
  ]) {
    assert.equal((await get(path)).status, 404, path);
  }
});

test('an app route ending in a server name is not mistaken for a file', async () => {
  for (const path of ['/rooms/!abc:matrix.org', '/space/!x:example.com/!y:example.com']) {
    assert.equal(await get(path), spa, path);
  }
});

test('an app route outside Cloudflare navigation detection still gets the app shell', async () => {
  assert.equal(await get('/space/abc/def'), spa);
});
