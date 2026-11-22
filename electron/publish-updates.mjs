import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { repository, server } from '../scripts/lib/forgejo.mjs';
import { dump, load } from './yaml.mjs';

const tag = process.env.TAG;
const version = process.env.VERSION;
const sha = process.env.SHA;
if (!tag || !version || !sha) throw new Error('TAG, VERSION and SHA are required');

const channel = version.includes('-nightly.') ? 'nightly' : 'latest';
const directory = resolve(process.argv[2] ?? join(import.meta.dirname, 'release'));
const files = readdirSync(directory, { withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => entry.name);
const artifacts = files.filter((name) =>
  /\.(deb|rpm|AppImage|tar\.gz|dmg|zip|exe|msi|blockmap)$/.test(name)
);
const manifests = files.filter((name) =>
  new RegExp(`^${channel}(-(mac|mac-x64|linux|linux-arm64))?\\.yml$`).test(name)
);
if (manifests.length === 0) throw new Error(`No ${channel} Electron update manifests found`);

const releaseUrl = `${server}/${repository}/releases/download/${encodeURIComponent(tag)}`;
const artifactUrl = (value) => {
  const name = value.startsWith(`${releaseUrl}/`)
    ? decodeURIComponent(value.slice(releaseUrl.length + 1))
    : value;
  if (!artifacts.includes(name))
    throw new Error(`Update manifest references missing artifact: ${name}`);
  return `${releaseUrl}/${encodeURIComponent(name)}`;
};

// Keep downloads on the versioned release when the channel advances.
for (const name of manifests) {
  const manifest = load(readFileSync(join(directory, name), 'utf8'));
  if (manifest.version !== version) throw new Error(`Unexpected version in ${name}`);
  for (const file of manifest.files) file.url = artifactUrl(file.url);
  if (manifest.path) manifest.path = artifactUrl(manifest.path);
  writeFileSync(join(directory, name), dump(manifest, { lineWidth: -1, noRefs: true }));
}

const release = join(import.meta.dirname, '../scripts/ci/forgejo-release.mjs');
const run = (...args) => execFileSync(process.execPath, [release, ...args], { stdio: 'inherit' });

// Upload installers before publishing their manifests.
run('upload', ...[...artifacts, ...manifests].map((name) => join(directory, name)));
run(
  'ensure',
  '--tag',
  channel,
  '--sha',
  sha,
  '--prerelease',
  String(channel === 'nightly'),
  '--title',
  channel === 'nightly' ? 'Nightly channel' : 'Latest stable',
  '--notes',
  `Electron update metadata for ${version}. Bundles live on the ${tag} release.`
);
run('upload', '--tag', channel, ...manifests.map((name) => join(directory, name)));
