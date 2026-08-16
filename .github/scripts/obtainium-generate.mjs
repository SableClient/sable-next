#!/usr/bin/env node

import { writeFileSync } from 'node:fs';
import process from 'node:process';

const [version, tag, outputPath] = process.argv.slice(2);
if (!version || !tag || !outputPath) {
  console.error('Usage: obtainium-generate.mjs <version> <tag> <output-file>');
  process.exit(1);
}

const repository = 'SableClient/sable-next';
const apkName = `sable-next-${version}-android-universal.apk`;
const apkUrl = `https://github.com/${repository}/releases/download/${tag}/${apkName}`;

// Obtainium fills in every other setting from its own defaults on import.
const additionalSettings = {
  about: 'The next Sable Matrix client',
  // The nightly tag name never changes, so the version has to come from the
  // release date instead.
  ...(tag === 'nightly' && {
    includePrereleases: true,
    useLatestAssetDateAsReleaseDate: true,
    releaseDateAsVersion: true,
    versionDetection: false,
  }),
};

const config = {
  apps: [
    {
      id: 'moe.sable.next',
      url: `https://github.com/${repository}`,
      author: 'SableClient',
      name: 'Sable Next',
      installedVersion: null,
      latestVersion: version,
      apkUrls: JSON.stringify([[apkName, apkUrl]]),
      otherAssetUrls: '[]',
      preferredApkIndex: 0,
      additionalSettings: JSON.stringify(additionalSettings),
      lastUpdateCheck: null,
      pinned: false,
      categories: ['Communication'],
      releaseDate: null,
      changeLog: null,
      overrideSource: 'GitHub',
      allowIdChange: false,
      pendingRepoRenameUrl: null,
    },
  ],
};

writeFileSync(outputPath, `${JSON.stringify(config, null, 2)}\n`);
console.log(`Generated ${outputPath} for ${apkName}`);
