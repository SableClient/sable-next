import { test } from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const script = join(import.meta.dirname, 'update-altstore-pal-source.mjs');
const template = join(import.meta.dirname, 'templates/altstore-pal-source.json');
const baseURL = 'https://git.sable.moe/SableClient/sable-next/releases/download/v2.4.0/';
const variant = 'fb855afc-8ce8-39b7-877e-63444105c95c';
const delta = '14cfc660-2913-399b-a4e0-de40ece4339c';

function fixture(root, adpFiles) {
  const adp = join(root, 'adp');
  for (const [path, contents] of Object.entries(adpFiles)) {
    mkdirSync(join(adp, path, '..'), { recursive: true });
    writeFileSync(join(adp, path), contents);
  }
  copyFileSync(template, join(root, 'source.json'));
  writeFileSync(
    join(root, 'entitlements.json'),
    JSON.stringify({
      'application-identifier': 'TEAM.moe.sable.app',
      'com.apple.developer.team-identifier': 'TEAM',
      'com.apple.security.application-groups': ['group.moe.sable.app'],
      'aps-environment': 'production',
      'get-task-allow': false,
    })
  );
  writeFileSync(
    join(root, 'extension-entitlements.json'),
    JSON.stringify({
      'com.apple.security.application-groups': ['group.moe.sable.app'],
      'keychain-access-groups': [],
    })
  );
  writeFileSync(
    join(root, 'info.json'),
    JSON.stringify({
      CFBundleIdentifier: 'moe.sable.app',
      NSMicrophoneUsageDescription: 'Calls',
      NSCameraUsageDescription: 'Video calls',
    })
  );
}

function run(root, version = '2.4.0', build = '1762700000') {
  return spawnSync(
    process.execPath,
    [
      script,
      ...['--source', join(root, 'source.json')],
      ...['--adp-dir', join(root, 'adp')],
      ...['--base-url', baseURL],
      ...['--version', version],
      ...['--build', build],
      ...['--marketplace-id', '6448401697'],
      ...['--entitlements', join(root, 'entitlements.json')],
      ...['--entitlements', join(root, 'extension-entitlements.json')],
      ...['--info', join(root, 'info.json')],
      ...['--date', '2026-11-09T00:00:00Z'],
      ...['--description', `Sable ${version}`],
    ],
    { encoding: 'utf8' }
  );
}

test('lists the ADP files and the app permissions', () => {
  const root = mkdtempSync(join(tmpdir(), 'sable-altstore-pal-'));
  try {
    fixture(root, {
      'manifest.json': '{}',
      signature: 'sig',
      [`variant/${variant}.ipa`]: 'ipa-bytes',
      [`delta/${delta}.ipa`]: 'delta',
    });
    const result = run(root);
    assert.equal(result.status, 0, result.stderr);

    const app = JSON.parse(readFileSync(join(root, 'source.json'), 'utf8')).apps[0];
    assert.equal(app.marketplaceID, '6448401697');
    assert.deepEqual(app.appPermissions, {
      entitlements: [
        'aps-environment',
        'com.apple.security.application-groups',
        'keychain-access-groups',
      ],
      privacy: { NSCameraUsageDescription: 'Video calls', NSMicrophoneUsageDescription: 'Calls' },
    });
    assert.deepEqual(app.versions[0], {
      version: '2.4.0',
      buildVersion: '1762700000',
      date: '2026-11-09T00:00:00Z',
      size: 9,
      downloadURL: `${baseURL}manifest.json`,
      assetURLs: {
        manifest: `${baseURL}manifest.json`,
        signature: `${baseURL}signature`,
        [variant]: `${baseURL}${variant}.ipa`,
        [delta]: `${baseURL}${delta}.ipa`,
      },
      localizedDescription: 'Sable 2.4.0',
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('puts the newest version first and replaces a republished one', () => {
  const root = mkdtempSync(join(tmpdir(), 'sable-altstore-pal-'));
  try {
    fixture(root, { 'manifest.json': '{}', signature: 'sig', [`variant/${variant}.ipa`]: 'ipa' });
    assert.equal(run(root, '2.3.8', '1').status, 0);
    assert.equal(run(root, '2.4.0', '2').status, 0);
    assert.equal(run(root, '2.4.0', '3').status, 0);

    const { versions } = JSON.parse(readFileSync(join(root, 'source.json'), 'utf8')).apps[0];
    assert.deepEqual(
      versions.map(({ version, buildVersion }) => [version, buildVersion]),
      [
        ['2.4.0', '3'],
        ['2.3.8', '1'],
      ]
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects ADP files that would collide as release assets', () => {
  const root = mkdtempSync(join(tmpdir(), 'sable-altstore-pal-'));
  try {
    fixture(root, {
      'manifest.json': '{}',
      signature: 'sig',
      [`variant/${variant}.ipa`]: 'ipa',
      [`delta/${variant}.ipa`]: 'ipa',
    });
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /two files named/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('rejects an ADP without a manifest', () => {
  const root = mkdtempSync(join(tmpdir(), 'sable-altstore-pal-'));
  try {
    fixture(root, { signature: 'sig', [`variant/${variant}.ipa`]: 'ipa' });
    const result = run(root);
    assert.equal(result.status, 1);
    assert.match(result.stderr, /missing manifest\.json/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
