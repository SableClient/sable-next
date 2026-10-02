import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { after, beforeEach, test } from 'node:test';
import { mkdtempSync, mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertBundleIsCurrent } from '../../tests/e2e/fixtures/bundle.ts';

const cwd = process.cwd();
const environment = { ...process.env };
const root = mkdtempSync(join(tmpdir(), 'sable-web-assets-'));
process.chdir(root);
execFileSync('git', ['init', '--quiet']);
execFileSync('git', [
  '-c',
  'user.name=Test',
  '-c',
  'user.email=test@example.test',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.hooksPath=/dev/null',
  'commit',
  '--quiet',
  '--allow-empty',
  '-m',
  'chore: test fixture',
]);
const revision = execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' });
for (const directory of ['dist', 'src', 'crates', 'static']) mkdirSync(directory);

beforeEach(() => {
  process.env.CI = 'true';
  process.env.SABLE_E2E_PREBUILT = '1';
  for (const file of ['src/app.ts', 'vite.config.ts', 'package.json']) {
    writeFileSync(file, '');
    utimesSync(file, 200, 200);
  }
  writeFileSync('dist/index.html', '');
  writeFileSync('dist/build-revision.txt', revision);
  utimesSync('dist/index.html', 100, 100);
});

after(() => {
  process.chdir(cwd);
  process.env = environment;
  rmSync(root, { recursive: true, force: true });
});

test('a prebuilt artifact from this revision survives a newer checkout timestamp', async () => {
  await assert.doesNotReject(assertBundleIsCurrent);
});

test('a prebuilt artifact from another revision is rejected despite a fresh timestamp', async () => {
  writeFileSync('dist/build-revision.txt', 'another-revision');
  utimesSync('dist/index.html', 300, 300);
  await assert.rejects(assertBundleIsCurrent, /revision/);
});

test('a prebuilt artifact without its revision is rejected', async () => {
  rmSync('dist/build-revision.txt');
  utimesSync('dist/index.html', 300, 300);
  await assert.rejects(assertBundleIsCurrent, /build-revision/);
});

test('local runs still reject a bundle older than the sources', async () => {
  delete process.env.CI;
  await assert.rejects(assertBundleIsCurrent, /older than its sources/);
});

test('local runs accept a bundle newer than the sources', async () => {
  delete process.env.CI;
  utimesSync('dist/index.html', 300, 300);
  await assert.doesNotReject(assertBundleIsCurrent);
});
