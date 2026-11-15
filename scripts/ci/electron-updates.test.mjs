import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const electronDir = fileURLToPath(new URL('../../electron/', import.meta.url));
const require = createRequire(join(electronDir, 'package.json'));
const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
const { Packager } = builderRequire('app-builder-lib/out/packager');
const { AppInfo } = builderRequire('app-builder-lib/out/appInfo');
const { MacPackager } = builderRequire('app-builder-lib/out/macPackager');
const { LinuxPackager } = builderRequire('app-builder-lib/out/linuxPackager');
const { PublishManager, getAppUpdatePublishConfiguration } = builderRequire(
  'app-builder-lib/out/publish/PublishManager'
);
const { CancellationToken } = builderRequire('builder-util-runtime');
const { Arch } = builderRequire('builder-util');
const { load } = createRequire(builderRequire.resolve('app-builder-lib/package.json'))('js-yaml');
const run = promisify(execFile);

for (const version of ['2.0.3', '26.11.0-nightly.15.1430.g07839c']) {
  test(`generates and publishes Electron update metadata for ${version}`, async (t) => {
    const channel = version.includes('-nightly.') ? 'nightly' : 'latest';
    const tag = channel === 'nightly' ? `nightly-${version}` : `v${version}`;
    const uploads = [];
    let channelExists = false;
    let failUploads = false;
    const server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url, 'http://localhost');
        const send = (data, status = 200) => {
          response.writeHead(status, { 'Content-Type': 'application/json' });
          response.end(JSON.stringify(data));
        };
        if (url.pathname.endsWith(`/releases/tags/${tag}`)) {
          send({ id: 1, assets: [] });
        } else if (url.pathname.endsWith(`/releases/tags/${channel}`)) {
          send({ id: 2, assets: [] }, channelExists ? 200 : 404);
        } else if (url.pathname.endsWith('/releases')) {
          const chunks = [];
          for await (const chunk of request) chunks.push(chunk);
          const release = JSON.parse(Buffer.concat(chunks).toString());
          assert.equal(release.tag_name, channel);
          assert.equal(release.prerelease, channel === 'nightly');
          channelExists = true;
          send({ id: 2, assets: [] }, 201);
        } else if (/\/releases\/[12]\/assets$/.test(url.pathname)) {
          if (failUploads) {
            send({ error: 'Artifact upload failed' }, 500);
            return;
          }
          const form = await new Request(url, {
            method: 'POST',
            headers: request.headers,
            body: Readable.toWeb(request),
            duplex: 'half',
          }).formData();
          uploads.push({
            release: Number(url.pathname.match(/\/releases\/(\d+)/)[1]),
            name: url.searchParams.get('name'),
            body: await form.get('attachment').text(),
          });
          send({}, 201);
        } else {
          send({ error: `Unexpected request: ${request.url}` }, 500);
        }
      } catch (error) {
        response.writeHead(500);
        response.end(String(error));
      }
    });
    server.listen(0, '127.0.0.1');
    await once(server, 'listening');
    t.after(() => server.close());
    const baseUrl = `http://127.0.0.1:${server.address().port}`;

    for (const platform of ['mac', 'linux']) {
      const directory = await mkdtemp(join(tmpdir(), 'sable-electron-updates-'));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const info = new Packager({
        projectDir: electronDir,
        config: { extraMetadata: { version } },
      });
      t.after(() => info.tempDirManager.cleanup());
      await info.validateConfig();
      assert.ok(info.config.mac.target.includes('zip'));
      info._appInfo = new AppInfo(info, null);
      const packager = platform === 'mac' ? new MacPackager(info) : new LinuxPackager(info);
      const arch = platform === 'mac' ? Arch.arm64 : Arch.x64;
      const publisher = new PublishManager(info, { publish: 'never' }, new CancellationToken());
      const config = await getAppUpdatePublishConfiguration(packager, null, arch, false);
      assert.equal(config.provider, 'generic');
      assert.equal(
        config.url,
        `https://git.sable.moe/SableClient/sable-next/releases/download/${channel}`
      );
      const extensions = platform === 'mac' ? ['dmg', 'zip'] : ['AppImage'];
      for (const ext of extensions) {
        const file = join(directory, `Sable Electron-${version}.${ext}`);
        await writeFile(file, `artifact ${ext}`);
        await info.emitArtifactCreated({
          packager,
          target: { name: ext.toLowerCase(), outDir: directory, options: {} },
          file,
          safeArtifactName: `sable-electron.${ext}`,
          arch,
          isWriteUpdateInfo: true,
        });
      }
      await publisher.awaitTasks();
      const name = `${channel}-${platform}.yml`;
      const original = load(await readFile(join(directory, name), 'utf8'));
      assert.equal(original.files.length, extensions.length);
      if (platform === 'mac') assert.match(original.path, /\.zip$/);

      const publish = () =>
        run(process.execPath, [join(electronDir, 'publish-updates.mjs'), directory], {
          env: {
            ...process.env,
            FORGEJO_URL: baseUrl,
            FORGEJO_REPOSITORY: 'SableClient/sable-next',
            FORGEJO_TOKEN: 'test-token',
            TAG: tag,
            VERSION: version,
            SHA: 'test-revision',
            GITHUB_TOKEN: 'test-token',
          },
        });
      const channelUploads = uploads.filter((upload) => upload.release === 2).length;
      failUploads = true;
      await assert.rejects(publish(), /failed: 500/);
      assert.equal(uploads.filter((upload) => upload.release === 2).length, channelUploads);
      // Retry after the manifest URLs have been rewritten.
      failUploads = false;
      await publish();
      const published = uploads.find((upload) => upload.release === 2 && upload.name === name);
      const manifest = load(published.body);
      assert.equal(manifest.version, version);
      for (const file of manifest.files) {
        const url = new URL(file.url);
        assert.ok(url.pathname.startsWith(`/SableClient/sable-next/releases/download/${tag}/`));
        const artifact = decodeURIComponent(url.pathname.split('/').at(-1));
        const uploaded = uploads.find((upload) => upload.release === 1 && upload.name === artifact);
        assert.ok(uploads.indexOf(uploaded) < uploads.indexOf(published));
        assert.equal(file.sha512, createHash('sha512').update(uploaded.body).digest('base64'));
      }
      assert.equal(manifest.path, manifest.files[0].url);
      assert.deepEqual(
        manifest.files.map((file) => file.sha512),
        original.files.map((file) => file.sha512)
      );
    }
    assert.ok(
      uploads
        .filter((upload) => upload.release === 2)
        .every((upload) => upload.name.endsWith('.yml'))
    );
  });
}
