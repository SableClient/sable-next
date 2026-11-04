import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { setTimeout } from 'node:timers/promises';
import test from 'node:test';

const builder = new URL('./build-wasm.mjs', import.meta.url);

test(
  'bindgen locking stays fresh during child processes and releases on failure',
  { timeout: 20_000 },
  async () => {
    const directory = await mkdtemp(join(tmpdir(), 'sable-wasm-lock-'));
    const bin = join(directory, 'bin');
    const output = join(directory, 'wasm');
    const log = join(directory, 'calls');
    try {
      await mkdir(bin);
      await writeFile(
        join(directory, 'Cargo.lock'),
        '[[package]]\nname="wasm-bindgen"\nversion="0.2.100"\n'
      );
      // A leftover file from the old PID lock must not block the new lock.
      await writeFile(`${output}.lock`, '999999999');
      const mock = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const command = path.basename(process.argv[1]);
if (command === 'cargo' && args[0] === 'metadata') console.log(JSON.stringify({target_directory: process.cwd()}));
if (command === 'wasm-bindgen') {
 if (args[0] === '--version') {console.log('wasm-bindgen 0.2.100'); process.exit(0);}
 const out = args[args.indexOf('--out-dir') + 1];
 const name = args[args.indexOf('--out-name') + 1];
 if (process.env.FAIL_BINDGEN) process.exit(1);
 if (name === 'sable_wasm') {
  fs.appendFileSync(process.env.CALLS, 'start ' + process.env.BUILD_ID + '\\n');
 }
 setTimeout(() => {
  fs.mkdirSync(out, {recursive:true});
  fs.writeFileSync(path.join(out, name + '_bg.wasm'), Buffer.from([0,97,115,109,1,0,0,0]));
  if (name === 'sable_wasm') fs.appendFileSync(process.env.CALLS, 'end ' + process.env.BUILD_ID + '\\n');
 }, name === 'sable_wasm' ? Number(process.env.BINDGEN_DELAY || 0) : 0);
}
if (command === 'wasm-opt') {
 if (args[0] === '--print-features') console.log('--enable-reference-types --enable-multivalue --enable-bulk-memory');
 const target = args.indexOf('-o');
 if (target >= 0) fs.copyFileSync(args[0], args[target + 1]);
}
`;
      for (const name of ['cargo', 'wasm-bindgen', 'wasm-opt']) {
        await writeFile(join(bin, name), mock, { mode: 0o755 });
      }
      function build(id, extra = {}) {
        const child = spawn(process.execPath, [builder.pathname], {
          cwd: directory,
          env: {
            ...process.env,
            PATH: `${bin}${delimiter}${process.env.PATH}`,
            SABLE_WASM_OUTPUT: output,
            CALLS: log,
            BUILD_ID: id,
            ...extra,
          },
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk) => {
          stderr += chunk;
        });
        return new Promise((resolve, reject) => {
          child.once('error', reject);
          child.once('close', (code) => resolve({ code, stderr }));
        });
      }
      const first = build('first', { BINDGEN_DELAY: '6500' });
      const lockPath = `${output}.bindgen.lock`;
      for (let attempt = 0; ; attempt++) {
        const locked = await stat(lockPath).catch(() => undefined);
        if (locked) break;
        assert.ok(attempt < 100, 'the first builder must acquire its lock');
        await setTimeout(20);
      }
      const acquired = (await stat(lockPath)).mtimeMs;
      const second = build('second');
      await setTimeout(5500);
      assert.ok(
        (await stat(lockPath)).mtimeMs > acquired,
        'the heartbeat must run while bindgen is active'
      );
      for (const result of await Promise.all([first, second]))
        assert.equal(result.code, 0, result.stderr);
      assert.deepEqual((await readFile(log, 'utf8')).trim().split('\n'), [
        'start first',
        'end first',
        'start second',
        'end second',
      ]);
      assert.equal(await stat(lockPath).catch(() => undefined), undefined);
      assert.notEqual((await build('failure', { FAIL_BINDGEN: '1' })).code, 0);
      assert.equal(await stat(lockPath).catch(() => undefined), undefined);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
);

test('release WASM and debug symbols are reproducible', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'sable-wasm-symbols-'));
  const bin = join(directory, 'bin');
  const output = join(directory, 'wasm');
  const log = join(directory, 'calls');
  try {
    await mkdir(bin);
    await mkdir(join(directory, '.cargo'));
    await writeFile(join(directory, '.cargo/config.toml'), '');
    await writeFile(
      join(directory, 'Cargo.lock'),
      '[[package]]\nname="wasm-bindgen"\nversion="0.2.100"\n'
    );
    const sentry = new URL('./bin.cjs', import.meta.resolve('sentry')).pathname;
    const mock = `#!/usr/bin/env node
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const command = path.basename(process.argv[1]);
fs.appendFileSync(process.env.CALLS, JSON.stringify({command, args}) + '\\n');
if (command === 'rustc') console.log('/rust');
if (command === 'cargo' && args[0] === 'metadata') console.log(JSON.stringify({target_directory: process.cwd()}));
if (command === 'wasm-bindgen') {
 if (args[0] === '--version') {console.log('wasm-bindgen 0.2.100'); process.exit(0);}
 if (args.includes('--remove-name-section')) throw new Error('names stripped before splitting');
 const out = args[args.indexOf('--out-dir') + 1];
 const name = args[args.indexOf('--out-name') + 1];
 fs.mkdirSync(out, {recursive:true});
 const sectionName = Buffer.from('name');
 const names = Buffer.from([0, 5, 4, 99, 111, 114, 101]);
 fs.writeFileSync(path.join(out, name + '_bg.wasm'), Buffer.concat([
  Buffer.from([
   0,97,115,109,1,0,0,0,
   1,4,1,96,0,0,3,2,1,0,7,7,1,3,114,117,110,0,0,10,4,1,2,0,11,
   0,1 + sectionName.length + names.length,sectionName.length
  ]), sectionName, names
 ]));
}
if (command === 'wasm-opt') {
 if (args[0] === '--print-features') console.log('--enable-reference-types --enable-multivalue --enable-bulk-memory');
 const target = args.indexOf('--output') >= 0 ? args.indexOf('--output') : args.indexOf('-o');
 if (target >= 0) {
  const source = args.find(arg => arg.endsWith('.wasm'));
  fs.copyFileSync(source, args[target + 1]);
 }
}
if (command === 'sentry') {
 const child = require('node:child_process').spawnSync(process.execPath, [${JSON.stringify(sentry)}, ...args], {stdio:'inherit'});
 process.exit(child.status ?? 1);
}
`;
    for (const name of ['rustc', 'cargo', 'wasm-bindgen', 'wasm-opt', 'sentry']) {
      await writeFile(join(bin, name), mock, { mode: 0o755 });
    }
    const build = () =>
      spawnSync(process.execPath, [builder.pathname, '--release'], {
        cwd: directory,
        env: {
          ...process.env,
          PATH: `${bin}${delimiter}${process.env.PATH}`,
          SABLE_WASM_OUTPUT: output,
          SABLE_WASM_NAMES: '0',
          CALLS: log,
          SENTRY_CONFIG_DIR: join(directory, 'sentry'),
        },
        stdio: ['ignore', 'ignore', 'pipe'],
        encoding: 'utf8',
      });
    const result = build();
    assert.equal(result.status, 0, result.stderr);
    for (const name of ['sable_wasm', 'sable_model']) {
      const shipped = new WebAssembly.Module(await readFile(join(output, `${name}_bg.wasm`)));
      const debug = new WebAssembly.Module(
        await readFile(join(output, 'debug', `${name}_bg.debug.wasm`))
      );
      assert.equal(typeof new WebAssembly.Instance(shipped).exports.run, 'function');
      assert.equal(typeof new WebAssembly.Instance(debug).exports.run, 'function');
      assert.equal(WebAssembly.Module.customSections(shipped, 'name').length, 0);
      assert.equal(WebAssembly.Module.customSections(debug, 'name').length, 1);
      assert.equal(WebAssembly.Module.customSections(shipped, 'external_debug_info').length, 1);
      const ids = WebAssembly.Module.customSections(shipped, 'build_id');
      assert.equal(ids.length, 1);
      assert.deepEqual(ids, WebAssembly.Module.customSections(debug, 'build_id'));
    }
    const calls = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const optimizations = calls.filter(
      (call) => call.command === 'wasm-opt' && call.args.includes('--output')
    );
    assert.equal(optimizations.length, 2);
    assert.ok(optimizations.every((call) => call.args.includes('-g')));
    const { default: image } = await import(join(output, 'sable_wasm_build_id.js'));
    const shipped = new WebAssembly.Module(await readFile(join(output, 'sable_wasm_bg.wasm')));
    const codeId = Buffer.from(WebAssembly.Module.customSections(shipped, 'build_id')[0]).toString(
      'hex'
    );
    assert.equal(image.code_id, codeId);
    assert.equal(image.debug_id, `${codeId.slice(0, 32)}0`);

    const artifacts = ['sable_wasm', 'sable_model'].flatMap((name) => [
      `${name}_bg.wasm`,
      `debug/${name}_bg.debug.wasm`,
      `${name}_build_id.js`,
    ]);
    artifacts.push('sable_wasm_version.js');
    const readArtifacts = () => Promise.all(artifacts.map((name) => readFile(join(output, name))));
    const expected = await readArtifacts();
    await rm(output, { recursive: true });
    const rebuilt = build();
    assert.equal(rebuilt.status, 0, rebuilt.stderr);
    assert.deepEqual(await readArtifacts(), expected);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
