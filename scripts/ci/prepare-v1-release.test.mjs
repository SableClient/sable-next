import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, cpSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { prepareV1Release } from './prepare-v1-release.mjs';

test('stable bundles keep v1 identity, Android package/JNI alignment and callback schemes, and preparation is repeatable', () => {
  const root = mkdtempSync(join(tmpdir(), 'sable-v1-release-'));
  try {
    for (const file of [
      'src-tauri/tauri.conf.json',
      'src-tauri/gen/android/app/src/main/java',
      'src-tauri/gen/android/buildSrc/src/main/java',
      'src-tauri/gen/android/app/src/main/res/values/strings.xml',
      'src-tauri/gen/android/app/build.gradle.kts',
      'src-tauri/gen/android/app/google-services.json',
      'src-tauri/src/mobile.rs',
      'src-tauri/src/main.rs',
    ]) {
      cpSync(file, join(root, file), { recursive: true });
    }
    prepareV1Release(root);
    prepareV1Release(root);
    const config = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
    assert.equal(config.identifier, 'moe.sable.client');
    assert.equal(config.productName, 'Sable');
    assert.ok(config.plugins['deep-link'].desktop.schemes.includes('moe.sable.app'));
    const source = join(
      root,
      'src-tauri/gen/android/app/src/main/java/moe/sable/client/MainActivity.kt'
    );
    assert.ok(readFileSync(source, 'utf8').startsWith('package moe.sable.client'));
    assert.ok(!existsSync(join(root, 'src-tauri/gen/android/app/src/main/java/moe/sable/next')));
    assert.ok(
      readFileSync(join(root, 'src-tauri/gen/android/app/build.gradle.kts'), 'utf8').includes(
        'applicationId = "moe.sable.client"'
      )
    );
    assert.ok(
      readFileSync(join(root, 'src-tauri/src/mobile.rs'), 'utf8').includes(
        'Java_moe_sable_client_MainActivity'
      )
    );
    assert.ok(
      readFileSync(join(root, 'src-tauri/src/main.rs'), 'utf8').includes(
        'identifier: "moe.sable.client"'
      )
    );
    const firebase = JSON.parse(
      readFileSync(join(root, 'src-tauri/gen/android/app/google-services.json'), 'utf8')
    );
    assert.ok(
      firebase.client.some(
        (client) => client.client_info.android_client_info.package_name === config.identifier
      )
    );
    assert.equal(
      JSON.parse(readFileSync('src-tauri/tauri.conf.json', 'utf8')).identifier,
      'moe.sable.next'
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
