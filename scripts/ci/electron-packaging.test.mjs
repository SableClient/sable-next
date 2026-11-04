import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import afterPack from '../../electron/after-pack.mjs';

const electronDir = fileURLToPath(new URL('../../electron/', import.meta.url));
const require = createRequire(join(electronDir, 'package.json'));
const builderRequire = createRequire(require.resolve('electron-builder/package.json'));
const { Packager } = builderRequire('app-builder-lib/out/packager');
const { AppInfo } = builderRequire('app-builder-lib/out/appInfo');
const { LinuxPackager } = builderRequire('app-builder-lib/out/linuxPackager');
const { WinPackager } = builderRequire('app-builder-lib/out/winPackager');
const { default: FpmTarget } = builderRequire('app-builder-lib/out/targets/FpmTarget');
const { LinuxTargetHelper } = builderRequire('app-builder-lib/out/targets/LinuxTargetHelper');
const { Arch } = builderRequire('builder-util');
const { createElectronFrameworkSupport } = builderRequire(
  'app-builder-lib/out/electron/ElectronFramework'
);

for (const flavor of ['stable', 'nightly']) {
  for (const format of ['deb', 'rpm']) {
    test(`${flavor} ${format} launcher and install hook`, async (t) => {
      const directory = await mkdtemp(join(tmpdir(), 'sable-electron-launcher-'));
      t.after(() => rm(directory, { recursive: true, force: true }));
      const appOutDir = join(directory, 'app');
      await mkdir(join(appOutDir, 'resources'), { recursive: true });
      const computeOptions = t.mock.fn(() => true);
      const info = new Packager({
        projectDir: electronDir,
        config: join(electronDir, `electron-builder.${flavor}.yml`),
        effectiveOptionComputed: computeOptions,
      });
      t.after(() => info.tempDirManager.cleanup());
      await info.validateConfig();
      info._appInfo = new AppInfo(info, null);
      info._framework = await createElectronFrameworkSupport(info.config, info);
      const packager = new LinuxPackager(info);
      const helper = new LinuxTargetHelper(packager);
      helper.computeDesktopIcons = async () => [];
      await new FpmTarget(format, packager, helper, directory).build(appOutDir, Arch.x64);

      assert.equal(computeOptions.mock.callCount(), 1);
      const [args, desktopFile] = computeOptions.mock.calls[0].arguments[0];
      const hook = format === 'rpm' ? '--rpm-posttrans' : '--after-install';
      const otherHook = format === 'rpm' ? '--after-install' : '--rpm-posttrans';
      assert.ok(args.includes(hook));
      assert.ok(!args.includes(otherHook));
      assert.ok(args.includes('--after-remove'));

      const executable = flavor === 'stable' ? 'sable' : 'sable-nightly';
      const product = flavor === 'stable' ? 'Sable' : 'Sable Nightly';
      const desktopName =
        flavor === 'stable' ? 'moe.sable.client' : 'moe.sable.next.electron.Nightly';
      const command = `/opt/${product}/${executable}`;
      const setup = await readFile(args[args.indexOf(hook) + 1], 'utf8');
      assert.ok(setup.includes(`'${command}'`));
      assert.ok(setup.includes(`'/usr/bin/${executable}'`));
      assert.ok(args.includes(`${desktopFile}=/usr/share/applications/${desktopName}.desktop`));
      const entry = await readFile(desktopFile, 'utf8');
      assert.ok(entry.includes(`\nExec=${flavor === 'nightly' ? `"${command}"` : command} %U\n`));
    });
  }
}

for (const electronPlatformName of ['win32', 'linux']) {
  for (const flavor of ['stable', 'nightly']) {
    test(`${flavor} ${electronPlatformName} packaging keeps Chromium locales`, async (t) => {
      const appOutDir = await mkdtemp(join(tmpdir(), 'sable-electron-locales-'));
      t.after(() => rm(appOutDir, { recursive: true, force: true }));
      const locales = [
        'en-US.pak',
        'en-GB.pak',
        'es-419.pak',
        'pt-BR.pak',
        'pt-PT.pak',
        'fr.pak',
        'zh-CN.pak',
      ];
      await mkdir(join(appOutDir, 'locales'));
      for (const locale of locales) {
        await writeFile(join(appOutDir, 'locales', locale), locale);
      }
      await writeFile(
        join(appOutDir, electronPlatformName === 'win32' ? 'electron.exe' : 'electron'),
        ''
      );

      const info = new Packager({
        projectDir: electronDir,
        config: join(electronDir, `electron-builder.${flavor}.yml`),
      });
      t.after(() => info.tempDirManager.cleanup());
      await info.validateConfig();
      info._appInfo = new AppInfo(info, null);
      const packager =
        electronPlatformName === 'win32' ? new WinPackager(info) : new LinuxPackager(info);
      const framework = await createElectronFrameworkSupport(info.config, info);
      await framework.beforeCopyExtraFiles({ appOutDir, packager });

      assert.deepEqual((await readdir(join(appOutDir, 'locales'))).sort(), locales.sort());
    });
  }

  test(`${electronPlatformName} packaging requires en-US.pak`, async (t) => {
    const appOutDir = await mkdtemp(join(tmpdir(), 'sable-electron-locales-'));
    t.after(() => rm(appOutDir, { recursive: true, force: true }));
    await mkdir(join(appOutDir, 'locales'));
    await writeFile(join(appOutDir, 'locales', 'fr.pak'), 'French');
    let fused = false;
    const context = {
      electronPlatformName,
      appOutDir,
      packager: {
        generateFuseConfig: (config) => config,
        addElectronFuses: () => {
          fused = true;
        },
      },
    };

    await assert.rejects(afterPack(context), { code: 'ENOENT' });
    assert.equal(fused, false);

    await writeFile(join(appOutDir, 'locales', 'en-US.pak'), 'English');
    await afterPack(context);
    assert.equal(fused, true);
  });
}
