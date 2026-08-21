import {
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const release = process.argv.includes('--release');
const profile = release ? 'wasm-release' : 'wasm-dev';
const cargoArgs = [
  'build',
  '--locked',
  '--package',
  'sable-wasm',
  '--target',
  'wasm32-unknown-unknown',
  '--profile',
  profile,
];

function run(command, args) {
  const result = spawnSync(command, args, { stdio: 'inherit' });

  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
}

function lockOutput(output) {
  const lock = `${output}.lock`;
  const wait = new Int32Array(new SharedArrayBuffer(4));

  for (;;) {
    try {
      const descriptor = openSync(lock, 'wx');
      writeFileSync(descriptor, String(process.pid));
      closeSync(descriptor);
      return () => unlinkSync(lock);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
        const pid = Number(readFileSync(lock, 'utf8'));
        if (Number.isSafeInteger(pid)) {
          try {
            process.kill(pid, 0);
          } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'ESRCH') {
              unlinkSync(lock);
              continue;
            }
          }
        }
        Atomics.wait(wait, 0, 0, 100);
        continue;
      }
      throw error;
    }
  }
}

const lockfile = readFileSync('Cargo.lock', 'utf8');
const version = lockfile.match(/name = "wasm-bindgen"\r?\nversion = "([^"]+)"/)?.[1];
const cli = spawnSync('wasm-bindgen', ['--version'], { encoding: 'utf8' });

if (!version || cli.status !== 0 || cli.stdout.trim() !== `wasm-bindgen ${version}`) {
  throw new Error(`wasm-bindgen-cli must match Cargo.lock's wasm-bindgen ${version ?? 'version'}`);
}

run('cargo', cargoArgs);

const wasm = `target/wasm32-unknown-unknown/${profile}/sable_wasm.wasm`;
const output = process.env.SABLE_WASM_OUTPUT ?? 'src/generated/wasm';
const bindgenArgs = ['--target', 'web', '--out-dir', output, '--out-name', 'sable_wasm'];
const unlockOutput = lockOutput(output);

try {
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
  writeFileSync(
    `${output}/sable_wasm_version.js`,
    `export default '${createHash('sha256').update(generated).digest('hex')}';\n`
  );
} finally {
  unlockOutput();
}
