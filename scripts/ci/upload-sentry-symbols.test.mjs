import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm, rename, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { execFile, execFileSync, spawnSync } from 'node:child_process';
import { createServer } from 'node:http';
import { promisify } from 'node:util';
import { collectSymbols, electronSymbolUrl } from './upload-sentry-symbols.mjs';

test('looks Electron symbols up under the original executable name', () => {
  assert.equal(
    electronSymbolUrl('a04856d0-a35c-543a-38fc-35b405ef0f4a'),
    'https://symbols.electronjs.org/electron/A04856D0A35C543A38FC35B405EF0F4A0/electron.sym'
  );
});

test('finds app symbols and excludes dependencies and bundles', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sable-symbols-'));
  try {
    const files = [
      'release/app',
      'release/app.pdb',
      'electron/dist/sable_node.node',
      'electron/dist/sable_audiofox.node',
      'electron/dist/venmic-x64.node',
      'aarch64-linux-android/release/libapp_lib.so',
      'release/deps/libdependency.so',
      'release/bundle/app',
      'debug/app',
      'build/archive/Sable.app.dSYM/Contents/Resources/DWARF/Sable',
      'build/archive/Sentry.framework.dSYM/Contents/Resources/DWARF/Sentry',
    ];
    for (const file of files) {
      await mkdir(join(root, file, '..'), { recursive: true });
      await writeFile(join(root, file), 'fixture');
    }
    assert.deepEqual((await collectSymbols(root)).map((path) => relative(root, path)).sort(), [
      'aarch64-linux-android/release/libapp_lib.so',
      'build/archive/Sable.app.dSYM',
      'electron/dist/sable_audiofox.node',
      'electron/dist/sable_node.node',
      'release/app',
      'release/app.pdb',
    ]);
    assert.deepEqual(await collectSymbols(join(root, 'debug')), [join(root, 'debug/app')]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test('keeps hidden outputs and dSYM boundaries with literal roots', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sable-[symbols]-'));
  try {
    const files = [
      '.cache/.abi/release/app',
      '.cache/.abi/release/build/app',
      'output/.nested/sable.exe',
      'output/.nested/deps/app',
      'output/incremental/app',
      'output/Sable.dSYM/Contents/Resources/DWARF/app',
      'output/Sentry.framework.dSYM/Contents/Resources/DWARF/app',
      'output/file.dSYM',
      'output/sable.pdb',
    ];
    for (const file of files) {
      await mkdir(join(root, file, '..'), { recursive: true });
      await writeFile(join(root, file), 'fixture');
    }
    await mkdir(join(root, 'output/app'));
    const expected = [
      '.cache/.abi/release/app',
      'output/.nested/sable.exe',
      'output/Sable.dSYM',
      'output/sable.pdb',
    ];
    assert.deepEqual(
      (await collectSymbols(root)).sort(),
      expected.map((path) => join(root, path))
    );
    const local = relative(process.cwd(), root);
    assert.deepEqual(
      (await collectSymbols(local)).sort(),
      expected.map((path) => join(local, path))
    );
    const dsym = join(root, 'output/Sable.dSYM');
    assert.deepEqual(await collectSymbols(dsym), [join(dsym, 'Contents/Resources/DWARF/app')]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'ignores symbolic-link outputs while allowing a symbolic-link root',
  {
    skip: process.platform === 'win32',
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'sable-symbols-'));
    try {
      await mkdir(join(root, 'release'));
      await mkdir(join(root, 'links'));
      await writeFile(join(root, 'release/app'), 'fixture');
      await symlink(join(root, 'release/app'), join(root, 'links/app'));
      await symlink(join(root, 'release'), join(root, 'linked-release'));
      await symlink(join(root, 'release'), join(root, 'linked.dSYM'));
      const alias = join(root, 'root-link');
      await symlink(root, alias);
      assert.deepEqual(await collectSymbols(root), [join(root, 'release/app')]);
      assert.deepEqual(await collectSymbols(alias), [join(alias, 'release/app')]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);

test(
  'propagates directory errors without opening dSYM bundle contents',
  {
    skip: process.platform === 'win32' || process.getuid?.() === 0,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'sable-symbols-'));
    const dsym = join(root, 'Sable.dSYM');
    const blocked = join(root, 'blocked');
    try {
      await mkdir(dsym);
      await chmod(dsym, 0);
      assert.deepEqual(await collectSymbols(root), [dsym]);
      await mkdir(blocked);
      await chmod(blocked, 0);
      await assert.rejects(collectSymbols(root), { code: 'EACCES' });
      const file = join(root, 'file');
      await writeFile(file, 'fixture');
      await assert.rejects(collectSymbols(file), { code: 'ENOTDIR' });
    } finally {
      await chmod(dsym, 0o700).catch(() => {});
      await chmod(blocked, 0o700).catch(() => {});
      await rm(root, { recursive: true, force: true });
    }
  }
);

test(
  'validates Electron addon debug data and matching macOS dSYMs',
  {
    skip: !['linux', 'darwin'].includes(process.platform) || spawnSync('cc', ['--version']).error,
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'sable-addon-symbols-'));
    try {
      const dist = join(root, 'dist');
      const source = join(root, 'addon.c');
      const binary = join(dist, 'sable_node.node');
      await mkdir(dist);
      await writeFile(source, 'int fixture(void) { return 1; }');
      const object = join(root, 'addon.o');
      const build = () => {
        execFileSync('cc', ['-g', '-fPIC', '-c', source, '-o', object]);
        execFileSync('cc', [
          '-g',
          ...(process.platform === 'darwin' ? ['-dynamiclib'] : ['-shared', '-Wl,--build-id']),
          object,
          '-o',
          binary,
        ]);
      };
      build();
      const dsym = `${binary}.dSYM`;
      if (process.platform === 'darwin') await rm(dsym, { recursive: true, force: true });
      const validate = () =>
        execFileSync(
          process.execPath,
          [join(import.meta.dirname, 'upload-sentry-symbols.mjs'), '--dry-run', dist],
          { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }
        );
      assert.match(validate(), /Validated 1 debug identifiers/);
      if (process.platform === 'darwin') {
        const savedDsym = join(root, 'previous.dSYM');
        await rename(dsym, savedDsym);
        await writeFile(source, 'int fixture(void) { return 2; }');
        build();
        await rm(dsym, { recursive: true, force: true });
        await rename(savedDsym, dsym);
        assert.throws(validate, /Debug identifiers do not match/);
      } else {
        execFileSync('strip', ['--strip-debug', binary]);
        assert.throws(validate, /Missing usable debug information/);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);

test('fails when a symbol directory cannot be read', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sable-symbols-'));
  try {
    await assert.rejects(collectSymbols(join(root, 'missing')), { code: 'ENOENT' });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test(
  'accepts existing symbols and still fails on server processing errors',
  {
    skip: !['linux', 'darwin'].includes(process.platform) || spawnSync('cc', ['--version']).error,
  },
  async (t) => {
    const root = await mkdtemp(join(tmpdir(), 'sable-symbol-upload-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    for (const [index, name] of ['sable_node', 'sable_audiofox'].entries()) {
      const source = join(root, `${name}.c`);
      const object = join(root, `${name}.o`);
      await writeFile(source, `int fixture(void) { return ${index}; }`);
      execFileSync('cc', ['-g', '-fPIC', '-c', source, '-o', object]);
      execFileSync('cc', [
        '-g',
        ...(process.platform === 'darwin' ? ['-dynamiclib'] : ['-shared', '-Wl,--build-id']),
        object,
        '-o',
        join(root, `${name}.node`),
      ]);
    }

    let mode = 'existing';
    let assembleCalls = 0;
    const server = createServer(async (request, response) => {
      response.setHeader('Content-Type', 'application/json');
      if (request.url === '/api/0/organizations/test/chunk-upload/') {
        response.end(
          JSON.stringify({
            url: `http://127.0.0.1:${server.address().port}/chunks/`,
            chunksPerRequest: 64,
            maxRequestSize: 32_000_000,
            hashAlgorithm: 'sha1',
            chunkSize: 1_000_000,
            concurrency: 1,
          })
        );
      } else if (request.url === '/api/0/projects/test/test/files/difs/assemble/') {
        let body = '';
        for await (const chunk of request) body += chunk;
        const entries = Object.entries(JSON.parse(body));
        assembleCalls++;
        response.end(
          JSON.stringify(
            Object.fromEntries(
              entries.map(([sha1, file]) => {
                const existing = mode === 'existing' || file.name.includes('sable_audiofox');
                const state = existing ? 'ok' : mode === 'error' ? 'error' : 'assembling';
                return [
                  sha1,
                  {
                    state: assembleCalls === 1 ? state : mode === 'error' ? 'error' : 'ok',
                    missingChunks: [],
                    detail: mode === 'error' && !existing ? 'Invalid debug data' : null,
                    dif: {
                      debugId: file.debug_id,
                      objectName: file.name,
                      cpuName: process.arch,
                      sha1,
                    },
                  },
                ];
              })
            )
          )
        );
      } else {
        response.writeHead(404);
        response.end('{}');
      }
    });
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    t.after(() => new Promise((resolve) => server.close(resolve)));
    const upload = () =>
      promisify(execFile)(
        process.execPath,
        [join(import.meta.dirname, 'upload-sentry-symbols.mjs'), root],
        {
          env: {
            ...process.env,
            VITE_SENTRY_DSN: 'https://public@example.invalid/1',
            SENTRY_AUTH_TOKEN: 'test-token',
            SENTRY_ORG: 'test',
            SENTRY_PROJECT: 'test',
            SENTRY_URL: `http://127.0.0.1:${server.address().port}`,
            SENTRY_DISABLE_UPDATE_CHECK: '1',
          },
          timeout: 15_000,
        }
      );
    assert.match((await upload()).stdout, /Nothing to upload, all files are on the server/);
    assert.equal(assembleCalls, 1);
    mode = 'mixed';
    assembleCalls = 0;
    assert.match((await upload()).stdout, /File processing complete/);
    assert.equal(assembleCalls, 2);
    mode = 'error';
    assembleCalls = 0;
    await assert.rejects(upload, /some symbols did not process correctly/);
  }
);

test(
  'validates debug data and requires every build output',
  {
    skip:
      process.platform !== 'linux' ||
      ['cc', 'strip'].some((tool) => spawnSync(tool, ['--version']).error),
  },
  async () => {
    const root = await mkdtemp(join(tmpdir(), 'sable-symbols-'));
    try {
      const release = join(root, 'release');
      const source = join(root, 'main.c');
      const binary = join(release, 'app');
      await mkdir(release);
      await writeFile(source, 'int main(void) { return 0; }');
      execFileSync('cc', ['-g', '-Wl,--build-id', source, '-o', binary]);
      const script = join(import.meta.dirname, 'upload-sentry-symbols.mjs');
      const validate = (...paths) =>
        execFileSync(process.execPath, [script, '--dry-run', ...paths], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: {
            ...process.env,
            VITE_SENTRY_DSN: 'https://public@example.invalid/1',
            SENTRY_AUTH_TOKEN: '',
            SENTRY_ORG: '',
            SENTRY_PROJECT: '',
            SENTRY_URL: 'http://127.0.0.1:1',
          },
        });
      assert.match(validate(release), /Validated 1 debug identifiers/);
      const missingAbi = join(root, 'armv7', 'release');
      await mkdir(missingAbi, { recursive: true });
      assert.throws(() => validate(release, missingAbi), /No native symbols found/);
      assert.throws(() => validate('--ios', release), /Missing iOS app dSYM/);
      execFileSync('strip', ['--strip-debug', binary]);
      assert.throws(() => validate(release), /Missing usable debug information/);
      execFileSync('cc', ['-g', '-Wl,--build-id=none', source, '-o', binary]);
      assert.throws(() => validate(release), /Missing build ID/);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }
);
