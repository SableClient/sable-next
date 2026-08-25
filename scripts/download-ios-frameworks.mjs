import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const frameworksDir = resolve(dirname(fileURLToPath(import.meta.url)), '../src-tauri/Frameworks');
const manifestPath = join(frameworksDir, '.manifest.json');

const frameworks = [
  {
    name: 'LiveKitWebRTC',
    url: 'https://github.com/livekit/webrtc-xcframework/releases/download/144.7559.11/LiveKitWebRTC.xcframework.zip',
    sha256: '07c5caf718058af3c528dcabd257298c40e5a8527e4fb9f47c48336ba5899853',
  },
  {
    name: 'RustLiveKitUniFFI',
    url: 'https://github.com/livekit/livekit-uniffi-xcframework/releases/download/0.0.6/RustLiveKitUniFFI.xcframework.zip',
    sha256: '0d3f2ce159a224c728f8b131068d53bbf9b13d968cda0edc68a6a2290f2651ed',
  },
];

async function readManifest() {
  try {
    return JSON.parse(await readFile(manifestPath, 'utf8'));
  } catch {
    return {};
  }
}

function extract(zipPath, destination) {
  const tool = spawnSync('ditto', ['--help'], { stdio: 'ignore' }).error ? 'unzip' : 'ditto';
  const args =
    tool === 'ditto' ? ['-x', '-k', zipPath, destination] : ['-q', zipPath, '-d', destination];
  const result = spawnSync(tool, args, { stdio: 'inherit' });

  if (result.status !== 0) throw new Error(`${tool} failed to extract ${zipPath}`);
}

async function provision({ name, url, sha256 }, manifest) {
  const target = join(frameworksDir, `${name}.xcframework`);

  if (manifest[name] === sha256 && existsSync(join(target, 'Info.plist'))) {
    console.log(`${name}.xcframework is already installed and verified`);
    return;
  }

  console.log(`Downloading ${name} from ${url}`);
  const response = await fetch(url, { redirect: 'follow' });

  if (!response.ok) {
    throw new Error(`failed to download ${name}: HTTP ${response.status} ${response.statusText}`);
  }

  const archive = Buffer.from(await response.arrayBuffer());
  const digest = createHash('sha256').update(archive).digest('hex');

  if (digest !== sha256) {
    throw new Error(`checksum mismatch for ${name}: expected ${sha256}, got ${digest}`);
  }

  const tempDir = await mkdtemp(join(frameworksDir, '.tmp-'));

  try {
    const zipPath = join(tempDir, `${name}.zip`);
    await writeFile(zipPath, archive);
    extract(zipPath, tempDir);

    const extracted = join(tempDir, `${name}.xcframework`);

    if (!existsSync(join(extracted, 'Info.plist'))) {
      throw new Error(`${name}'s archive holds no ${name}.xcframework`);
    }

    await rm(target, { recursive: true, force: true });
    await rename(extracted, target);
  } finally {
    await rm(tempDir, { recursive: true, force: true });
  }

  manifest[name] = sha256;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`Installed ${name}.xcframework`);
}

await mkdir(frameworksDir, { recursive: true });
const manifest = await readManifest();

for (const framework of frameworks) {
  await provision(framework, manifest);
}
