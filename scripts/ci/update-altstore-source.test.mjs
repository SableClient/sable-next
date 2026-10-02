import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const script = fileURLToPath(new URL('./update-altstore-source.mjs', import.meta.url));
const releaseURL = 'https://git.sable.moe/SableClient/sable-next/releases/download/nightly-test/';

test('rejects download URLs without an IPA filename', () => {
  const root = mkdtempSync(join(tmpdir(), 'sable-altstore-'));
  try {
    const path = join(root, 'source.json');
    const original = JSON.stringify({ apps: [{ versions: [] }] });
    writeFileSync(path, original);
    const result = spawnSync(
      process.execPath,
      [script, path, '0.0.100', '0.0.100', '123', releaseURL, '2026-10-02', 'Sable Next'],
      { encoding: 'utf8' }
    );
    assert.equal(result.status, 1);
    assert.match(result.stderr, /downloadURL must point to an IPA/);
    assert.equal(readFileSync(path, 'utf8'), original);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('drops broken versions and keeps valid downloads', () => {
  const root = mkdtempSync(join(tmpdir(), 'sable-altstore-'));
  try {
    const path = join(root, 'source.json');
    const valid = { version: '0.0.98', downloadURL: `${releaseURL}older.ipa` };
    writeFileSync(
      path,
      JSON.stringify({
        apps: [{ versions: [{ version: '0.0.99', downloadURL: releaseURL }, valid] }],
      })
    );
    const downloadURL = `${releaseURL}latest.ipa`;
    const result = spawnSync(
      process.execPath,
      [script, path, '0.0.100', '0.0.100', '123', downloadURL, '2026-10-02', 'Sable Next'],
      { encoding: 'utf8' }
    );
    assert.equal(result.status, 0, result.stderr);
    const versions = JSON.parse(readFileSync(path, 'utf8')).apps[0].versions;
    assert.equal(versions.length, 2);
    assert.equal(versions[0].downloadURL, downloadURL);
    assert.deepEqual(versions[1], valid);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
