import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { parse, valid } from 'semver';

export function tauriVersionConfig(version) {
  const parsed = parse(version);
  if (!parsed) throw new Error(`Invalid semantic version: ${version}`);
  const nightlyVersion =
    /^(\d+)\.(\d+)\.(\d+)-nightly\.(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})(?:\.g?[0-9a-f]+)?$/.exec(
      version
    );
  let androidVersionCode = nightlyVersion
    ? Date.UTC(
        2000 + +nightlyVersion[4],
        +nightlyVersion[5] - 1,
        +nightlyVersion[6],
        +nightlyVersion[7],
        +nightlyVersion[8],
        +nightlyVersion[9]
      ) / 1000
    : // Keep standard APKs on the same scale as previously released FOSS APKs.
      [parsed.major, parsed.minor, parsed.patch].reduce((code, part) => code * 1000 + part, 0) * 10;

  if (/-nightly\.\d{1,2}\.\d{1,4}\.g[0-9a-f]{6}$/.test(version)) {
    androidVersionCode = Number(
      execFileSync('git', ['log', '-1', '--format=%ct'], { encoding: 'utf8' }).trim()
    );
  }

  if (parsed.minor >= 1000 || parsed.patch >= 1000) {
    throw new Error('Android versions require minor and patch numbers below 1000');
  }

  if (
    !Number.isSafeInteger(androidVersionCode) ||
    androidVersionCode < 1 ||
    androidVersionCode + 4 > 2_100_000_000
  ) {
    throw new Error(`Android version code is out of range: ${androidVersionCode}`);
  }

  return {
    version,
    bundle: { android: { versionCode: androidVersionCode } },
  };
}

if (import.meta.main) {
  const version = process.argv[2];

  if (!version || !valid(version)) {
    console.error(`Usage: set-tauri-version.mjs <version>  (got: ${version ?? '<none>'})`);
    process.exit(1);
  }

  const patch = tauriVersionConfig(version);
  const file = 'src-tauri/tauri.conf.json';
  const config = JSON.parse(readFileSync(file, 'utf8'));
  config.version = patch.version;
  config.bundle ??= {};
  config.bundle.android ??= {};
  config.bundle.android.versionCode = patch.bundle.android.versionCode;
  writeFileSync(file, `${JSON.stringify(config, null, 2)}\n`);
  console.log(`Set ${file} version to ${version}`);
}
