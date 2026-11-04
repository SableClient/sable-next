import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { execFile, spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs, promisify } from 'node:util';
import { lock } from 'proper-lockfile';
import { cargoPackageVersion, cargoRustFlags } from '../lib/cargo.mjs';
import { sha256 } from '../lib/download.mjs';
import { wasmDebugIds } from '../../src/worker/wasm-debug.ts';

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
];

function run(command, args, env) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: 'inherit', env: env ?? process.env });
    child.once('error', reject);
    child.once('close', (status, signal) => {
      if (status === 0) resolve();
      else reject(new Error(`${command} failed with ${signal ?? `status ${status}`}`));
    });
  });
}

const execFileAsync = promisify(execFile);

async function capture(command, args) {
  return (await execFileAsync(command, args, { encoding: 'utf8' })).stdout;
}

async function releaseEnvironment() {
  const config = readFileSync('.cargo/config.toml', 'utf8');
  const flags = cargoRustFlags(config, 'wasm32-unknown-unknown');
  const cargoHome = process.env.CARGO_HOME ?? join(homedir(), '.cargo');

  flags.push(
    `--remap-path-prefix=${cargoHome}=/cargo`,
    `--remap-path-prefix=${(await capture('rustc', ['--print', 'sysroot'])).trim()}=/rust`,
    `--remap-path-prefix=${process.cwd()}=/sable`
  );

  return { ...process.env, CARGO_ENCODED_RUSTFLAGS: flags.join('\x1f') };
}

async function targetDirectory() {
  return JSON.parse(await capture('cargo', ['metadata', '--no-deps', '--format-version', '1']))
    .target_directory;
}

const lockfile = readFileSync('Cargo.lock', 'utf8');
const version = cargoPackageVersion(lockfile, 'wasm-bindgen');
const cli = await capture('wasm-bindgen', ['--version']).catch(() => '');

if (!version || cli.trim() !== `wasm-bindgen ${version}`) {
  throw new Error(`wasm-bindgen-cli must match Cargo.lock's wasm-bindgen ${version ?? 'version'}`);
}

await run('cargo', cargoArgs, release ? await releaseEnvironment() : undefined);

const built = `${await targetDirectory()}/wasm32-unknown-unknown/${profile}`;
const output = process.env.SABLE_WASM_OUTPUT ?? 'src/generated/wasm';

async function bindgen(input, name, { optimize, features = [] }) {
  const wasm = `${output}/${name}_bg.wasm`;
  const args = ['--target', 'web', '--out-dir', output, '--out-name', name];
  if (release) args.push('--remove-producers-section');
  else args.push('--debug');
  await run('wasm-bindgen', [...args, `${built}/${input}`]);

  if (features.length > 0) {
    const declared = await capture('wasm-opt', ['--print-features', wasm]);
    for (const required of features) {
      if (!declared.includes(`--enable-${required}`)) {
        throw new Error(`the target_features section does not declare ${required}`);
      }
    }
  }

  if (release) {
    const optimized = `${output}/${name}_bg.optimized.wasm`;

    await run('wasm-opt', [...optimize, '-g', wasm, '--output', optimized]);
    rmSync(wasm);
    renameSync(optimized, wasm);

    const debug = `${output}/debug/${name}_bg.debug.wasm`;
    mkdirSync(`${output}/debug`, { recursive: true });
    // wasm-split defaults to a random ID.
    const buildId = sha256(readFileSync(wasm))
      .slice(0, 32)
      .replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5');
    await run('sentry', [
      'wasm-split',
      wasm,
      '-d',
      debug,
      '--build-id',
      buildId,
      '--strip',
      ...(keepNames ? [] : ['--strip-names']),
    ]);
  }

  const generated = readFileSync(wasm);
  const module = await WebAssembly.compile(generated);
  writeFileSync(
    `${output}/${name}_build_id.js`,
    `export default ${JSON.stringify(wasmDebugIds(module))};\n`
  );
  writeFileSync(
    `${output}/${name}_build_id.d.ts`,
    'declare const image: { code_id: string; debug_id: string } | undefined;\nexport default image;\n'
  );

  // Validate instructions independently of the module's target_features section.
  const validationInput = `${output}/${name}_bg.validation.wasm`;
  try {
    await run('wasm-opt', [wasm, '--strip-target-features', '-o', validationInput]);
    await run('wasm-opt', [validationInput, '--all-features', '--disable-simd']);
  } finally {
    rmSync(validationInput, { force: true });
  }

  return generated;
}

const unlockOutput = await lock(output, {
  realpath: false,
  // Earlier builders used a PID file at `${output}.lock`.
  lockfilePath: `${output}.bindgen.lock`,
  retries: { forever: true, minTimeout: 100, maxTimeout: 1000 },
});

try {
  const generated = await bindgen('sable_wasm.wasm', 'sable_wasm', {
    optimize: ['-O3', '--gufa', '-O3'],
    features: ['reference-types', 'multivalue', 'bulk-memory'],
  });
  writeFileSync(`${output}/sable_wasm_version.js`, `export default '${sha256(generated)}';\n`);

  await bindgen('sable_model_wasm.wasm', 'sable_model', {
    optimize: ['-Oz'],
  });
} finally {
  await unlockOutput();
}
