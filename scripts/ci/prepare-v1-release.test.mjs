import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareV1Release } from './prepare-v1-release.mjs';

test('stable iOS bundles keep v1 identity and callback schemes, and preparation is repeatable', () => {
  const root = mkdtempSync(join(tmpdir(), 'sable-v1-release-'));
  try {
    for (const file of ['src-tauri/tauri.conf.json', 'src-tauri/ios-project.yml']) {
      cpSync(file, join(root, file), { recursive: true });
    }
    prepareV1Release(root);
    prepareV1Release(root);
    const config = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
    assert.equal(config.identifier, 'moe.sable.client');
    assert.equal(config.productName, 'Sable');
    assert.deepEqual(config.plugins['deep-link'].mobile[0].scheme, [
      'moe.sable.app',
      'sable',
      'matrix',
    ]);
    for (const host of ['link.sable.moe', 'matrix.to'])
      assert.ok(
        config.plugins['deep-link'].mobile.some(
          (domain) => domain.host === host && domain.appLink === false
        )
      );
    const plist = readFileSync(join(root, 'src-tauri/ios-project.yml'), 'utf8');
    assert.ok(plist.includes('- moe.sable.app') && !plist.includes('- moe.sable.next'));
    assert.ok(plist.includes('- matrix'));
    assert.equal(
      JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).identifier,
      'moe.sable.next'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
