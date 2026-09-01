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
import { homedir } from 'node:os';
import { join } from 'node:path';

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

const MAX_RELEASE_WASM_BYTES = 16_500_000;

function run(command, args, env) {
  const result = spawnSync(command, args, { stdio: 'inherit', env: env ?? process.env });

  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
}

function capture(command, args) {
  const result = spawnSync(command, args, { encoding: 'utf8' });

  if (result.status !== 0) throw new Error(`${command} failed with status ${result.status}`);
  return result.stdout;
}

function releaseEnvironment() {
  const config = readFileSync('.cargo/config.toml', 'utf8');
  const declared = config.match(
    /\[target\.wasm32-unknown-unknown\][\s\S]*?rustflags\s*=\s*\[([\s\S]*?)\]/
  )?.[1];

  if (!declared) throw new Error('.cargo/config.toml declares no wasm32 rustflags');

  const flags = [...declared.matchAll(/'([^']*)'|"((?:[^"\\]|\\.)*)"/g)].map((match) =>
    match[1] === undefined ? match[2].replaceAll('\\"', '"') : match[1]
  );
  const cargoHome = process.env.CARGO_HOME ?? join(homedir(), '.cargo');

  flags.push(
    `--remap-path-prefix=${cargoHome}=/cargo`,
    `--remap-path-prefix=${capture('rustc', ['--print', 'sysroot']).trim()}=/rust`,
    `--remap-path-prefix=${process.cwd()}=/sable`
  );

  return { ...process.env, CARGO_ENCODED_RUSTFLAGS: flags.join('\x1f') };
}

function targetDirectory() {
  const result = spawnSync('cargo', ['metadata', '--no-deps', '--format-version', '1'], {
    encoding: 'utf8',
  });

  if (result.status !== 0) throw new Error('cargo metadata failed');
  return JSON.parse(result.stdout).target_directory;
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

run('cargo', cargoArgs, release ? releaseEnvironment() : undefined);

const wasm = `${targetDirectory()}/wasm32-unknown-unknown/${profile}/sable_wasm.wasm`;
const output = process.env.SABLE_WASM_OUTPUT ?? 'src/generated/wasm';
const bindgenArgs = ['--target', 'web', '--out-dir', output, '--out-name', 'sable_wasm'];
const unlockOutput = lockOutput(output);

try {
  if (release) bindgenArgs.push('--remove-name-section', '--remove-producers-section');
  else bindgenArgs.push('--debug');

  bindgenArgs.push(wasm);
  run('wasm-bindgen', bindgenArgs);

  const features = capture('wasm-opt', ['--print-features', `${output}/sable_wasm_bg.wasm`]);

  for (const required of ['reference-types', 'multivalue', 'bulk-memory']) {
    if (!features.includes(`--enable-${required}`)) {
      throw new Error(`the target_features section does not declare ${required}`);
    }
  }

  if (release) {
    const optimized = `${output}/sable_wasm_bg.optimized.wasm`;

    run('wasm-opt', [
      '-O3',
      '--gufa',
      '-O3',
      `${output}/sable_wasm_bg.wasm`,
      '--output',
      optimized,
    ]);
    rmSync(`${output}/sable_wasm_bg.wasm`);
    renameSync(optimized, `${output}/sable_wasm_bg.wasm`);
  }

  const generated = readFileSync(`${output}/sable_wasm_bg.wasm`);
  await WebAssembly.compile(generated);

  if (release && generated.byteLength > MAX_RELEASE_WASM_BYTES) {
    throw new Error(
      `the release wasm is ${generated.byteLength} bytes, over the ${MAX_RELEASE_WASM_BYTES} budget`
    );
  }
  writeFileSync(
    `${output}/sable_wasm_version.js`,
    `export default '${createHash('sha256').update(generated).digest('hex')}';\n`
  );
} finally {
  unlockOutput();
}
