import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { tauriVersionConfig } from './set-tauri-version.mjs';
import { lt } from 'semver';

test('nightly metadata handles a numeric SHA with a leading zero', () => {
  const dir = mkdtempSync(join(tmpdir(), 'sable-release-meta-'));
  try {
    const output = join(dir, 'output');
    const result = spawnSync(process.execPath, ['scripts/ci/release-meta.mjs', output], {
      env: {
        ...process.env,
        EVENT_NAME: 'push',
        GIT_REF: 'refs/heads/main',
        GIT_SHA: '0998581289923621b1aa3b0059ba38fdadee9dfb',
      },
      encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr);
    const version = /^version=(.+)$/m.exec(readFileSync(output, 'utf8'))[1];
    assert.match(version, /^\d+\.\d+\.\d+-nightly\.\d{1,2}\.\d{1,4}\.g099858$/);
    assert.ok(lt(JSON.parse(readFileSync('package.json', 'utf8')).version, version));
    assert.ok(lt(version, version.split('-')[0]));
    assert.equal(
      tauriVersionConfig(version).bundle.android.versionCode,
      Number(execFileSync('git', ['log', '-1', '--format=%ct'], { encoding: 'utf8' }).trim())
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
