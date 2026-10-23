import {
  closeSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { sha256 } from '../lib/download.mjs';

const { release } = parseArgs({ options: { release: { type: 'boolean' } } }).values;
const profile = release ? 'wasm-release' : 'wasm-dev';
const keepNames = release && process.env.SABLE_WASM_NAMES === '1';
const cargoArgs = [
  'build',
  '--locked',
  '--package',
  'sable-wasm',
  '--package',
  'sable-model-wasm',
  '--target',
  'wasm32-unknown-unknown',
  '--profile',
  profile,
  ...(process.env.SABLE_WASM_FEATURES ? ['--features', process.env.SABLE_WASM_FEATURES] : []),
];

const MAX_RELEASE_WASM_BYTES = 20 * 1024 * 1024;
// Includes the HTML parser used by notification previews.
const MAX_RELEASE_MODEL_BYTES = 1200 * 1024;

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

  const flags = [...(declared ?? '').matchAll(/'([^']*)'|"((?:[^"\\]|\\.)*)"/g)].map((match) =>
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
  return JSON.parse(capture('cargo', ['metadata', '--no-deps', '--format-version', '1']))
    .target_directory;
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

const built = `${targetDirectory()}/wasm32-unknown-unknown/${profile}`;
const output = process.env.SABLE_WASM_OUTPUT ?? 'src/generated/wasm';

async function bindgen(input, name, { optimize, budget, features = [] }) {
  const wasm = `${output}/${name}_bg.wasm`;
  const args = ['--target', 'web', '--out-dir', output, '--out-name', name];
  if (keepNames) args.push('--remove-producers-section');
  else if (release) args.push('--remove-name-section', '--remove-producers-section');
  else args.push('--debug');
  run('wasm-bindgen', [...args, `${built}/${input}`]);

  if (features.length > 0) {
    const declared = capture('wasm-opt', ['--print-features', wasm]);
    for (const required of features) {
      if (!declared.includes(`--enable-${required}`)) {
        throw new Error(`the target_features section does not declare ${required}`);
      }
    }
  }

  if (release) {
    const optimized = `${output}/${name}_bg.optimized.wasm`;

    run('wasm-opt', [...optimize, ...(keepNames ? ['-g'] : []), wasm, '--output', optimized]);
    rmSync(wasm);
    renameSync(optimized, wasm);
  }

  const generated = readFileSync(wasm);
  await WebAssembly.compile(generated);

  if (release && !keepNames && generated.byteLength > budget) {
    throw new Error(`${wasm} is ${generated.byteLength} bytes, over the ${budget} budget`);
  }
  return generated;
}

const unlockOutput = lockOutput(output);

try {
  const generated = await bindgen('sable_wasm.wasm', 'sable_wasm', {
    optimize: ['-O3', '--gufa', '-O3'],
    budget: MAX_RELEASE_WASM_BYTES,
    features: ['reference-types', 'multivalue', 'bulk-memory'],
  });
  writeFileSync(`${output}/sable_wasm_version.js`, `export default '${sha256(generated)}';\n`);

  await bindgen('sable_model_wasm.wasm', 'sable_model', {
    optimize: ['-Oz'],
    budget: MAX_RELEASE_MODEL_BYTES,
  });
} finally {
  unlockOutput();
}
