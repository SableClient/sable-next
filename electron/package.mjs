import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const version =
  process.env.VERSION || JSON.parse(readFileSync(join(here, '../package.json'), 'utf8')).version;
const builder = createRequire(import.meta.url).resolve('electron-builder/cli.js');

const args = process.argv.slice(2);
const sandboxed = args.includes('--sandboxed');
if (sandboxed && process.platform !== 'darwin') {
  throw new Error('The sandboxed build requires macOS.');
}
const stable = process.env.SABLE_BUILD_FLAVOR === 'stable';
let config = stable ? 'electron-builder.stable.yml' : 'electron-builder.nightly.yml';
let identifier = stable ? 'moe.sable.client' : 'moe.sable.next.nightly';
if (sandboxed) {
  config = 'electron-builder.sandboxed.yml';
  identifier = 'moe.sable.client.sandboxed';
}
const env = { ...process.env, VITE_APP_VERSION: version, SABLE_IDENTIFIER: identifier };

execFileSync(process.execPath, [join(here, 'build.mjs'), '--release'], { stdio: 'inherit', env });
execFileSync(
  process.execPath,
  [join(here, '../scripts/ci/upload-sentry-sourcemaps.mjs'), join(here, 'dist')],
  { stdio: 'inherit', env }
);
execFileSync(
  process.execPath,
  [
    builder,
    '--publish',
    'never',
    `-c.extraMetadata.version=${version}`,
    '--config',
    config,
    ...args.filter((arg) => arg !== '--sandboxed'),
  ],
  { cwd: here, stdio: 'inherit' }
);
