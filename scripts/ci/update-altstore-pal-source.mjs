import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, dirname, extname, join } from 'node:path';
import { parseArgs } from 'node:util';

const names = [
  'source',
  'adp-dir',
  'base-url',
  'version',
  'build',
  'marketplace-id',
  'entitlements',
  'info',
  'date',
  'description',
];
const { values: args } = parseArgs({
  options: Object.fromEntries(
    names.map((name) => [name, { type: 'string', multiple: name === 'entitlements' }])
  ),
});
if (names.some((name) => !args[name])) {
  console.error(
    `Usage: update-altstore-pal-source.mjs ${names.map((name) => `--${name}`).join(' ')}`
  );
  process.exit(1);
}

const files = readdirSync(args['adp-dir'], { recursive: true, withFileTypes: true })
  .filter((entry) => entry.isFile())
  .map((entry) => join(entry.parentPath, entry.name));

// Release assets are flat, so every ADP file must keep a unique name.
const assetURLs = {};
for (const file of files) {
  const name = basename(file);
  const key = basename(name, extname(name));
  if (assetURLs[key]) {
    console.error(`ADP has two files named ${key}, which cannot share one release.`);
    process.exit(1);
  }
  assetURLs[key] = new URL(encodeURIComponent(name), args['base-url']).href;
}

const variant = files.find(
  (file) => basename(dirname(file)) === 'variant' && file.endsWith('.ipa')
);
if (!assetURLs.manifest || !assetURLs.signature || !variant) {
  console.error(`${args['adp-dir']} is missing manifest.json, signature or a variant/*.ipa.`);
  process.exit(1);
}

const hiddenEntitlements = new Set([
  'application-identifier',
  'com.apple.developer.team-identifier',
]);
const entitlements = new Set(
  args.entitlements.flatMap((path) =>
    Object.entries(JSON.parse(readFileSync(path, 'utf8')))
      .filter(([key, value]) => value !== false && !hiddenEntitlements.has(key))
      .map(([key]) => key)
  )
);
const info = JSON.parse(readFileSync(args.info, 'utf8'));

const source = JSON.parse(readFileSync(args.source, 'utf8'));
const app = source.apps?.[0];
if (!app) {
  console.error(`${args.source} has no apps[0] to update.`);
  process.exit(1);
}

app.marketplaceID = args['marketplace-id'];
app.appPermissions = {
  entitlements: [...entitlements].sort(),
  privacy: Object.fromEntries(
    Object.entries(info)
      .filter(([key]) => key.endsWith('UsageDescription'))
      .sort(([a], [b]) => a.localeCompare(b))
  ),
};

const entry = {
  version: args.version,
  buildVersion: args.build,
  date: args.date,
  size: statSync(variant).size,
  downloadURL: assetURLs.manifest,
  assetURLs,
  localizedDescription: args.description,
};
app.versions = [
  entry,
  ...(app.versions ?? []).filter((candidate) => candidate.version !== entry.version),
].slice(0, 20);

writeFileSync(args.source, `${JSON.stringify(source, null, 2)}\n`);
console.log(
  `Updated ${args.source}: ${app.bundleIdentifier} ${entry.version} (${entry.buildVersion})`
);
