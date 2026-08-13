import { readFileSync, renameSync, rmSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

const release = process.argv.includes('--release');
const cargoArgs = [
  'build',
  '--locked',
  '--package',
  'sable-wasm',
  '--target',
  'wasm32-unknown-unknown',
];

if (release) cargoArgs.push('--profile', 'wasm-release');

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });

  if (result.status !== 0) process.exit(result.status ?? 1);
}

const lockfile = readFileSync('Cargo.lock', 'utf8');
const version = lockfile.match(/name = "wasm-bindgen"\r?\nversion = "([^"]+)"/)?.[1];
const cli = spawnSync('wasm-bindgen', ['--version'], { encoding: 'utf8' });

if (!version || cli.status !== 0 || cli.stdout.trim() !== `wasm-bindgen ${version}`) {
  throw new Error(`wasm-bindgen-cli must match Cargo.lock's wasm-bindgen ${version ?? 'version'}`);
}

run('cargo', cargoArgs);

const profile = release ? 'wasm-release' : 'debug';
const wasm = `target/wasm32-unknown-unknown/${profile}/sable_wasm.wasm`;
const output = 'src/generated/wasm';
const bindgenArgs = ['--target', 'web', '--out-dir', output, '--out-name', 'sable_wasm'];

if (release) bindgenArgs.push('--remove-name-section', '--remove-producers-section');

bindgenArgs.push(wasm);
run('wasm-bindgen', bindgenArgs);

if (release) {
  const optimized = `${output}/sable_wasm_bg.optimized.wasm`;

  run('wasm-opt', [
    '-Oz',
    '--enable-bulk-memory',
    '--enable-nontrapping-float-to-int',
    `${output}/sable_wasm_bg.wasm`,
    '--output',
    optimized,
  ]);
  rmSync(`${output}/sable_wasm_bg.wasm`);
  renameSync(optimized, `${output}/sable_wasm_bg.wasm`);
}

const generated = readFileSync(`${output}/sable_wasm_bg.wasm`);
await WebAssembly.compile(generated);
