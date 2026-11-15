import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { nextCalver } from '../lib/calver.mjs';

const args = process.argv.slice(2);
if (args[0] === '--') args.shift();
if (args.includes('prepare-release') && !args.includes('--help')) {
  if (args.some((arg) => arg === '--override-version' || arg.startsWith('--override-version='))) {
    throw new Error('prepare-release calculates its CalVer version. Omit --override-version');
  }
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  args.push('--override-version', nextCalver(version));
}

const result = spawnSync('knope', args, { stdio: 'inherit' });
if (result.error) throw result.error;
process.exitCode = result.status ?? 1;
