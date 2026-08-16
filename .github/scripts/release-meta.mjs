#!/usr/bin/env node

// sable-next has no changelog tooling, so nightly versions carry a commit-date stamp.

import { execSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import process from 'node:process';

function commitDate() {
  try {
    const seconds = execSync('git log -1 --format=%ct', {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (/^\d+$/.test(seconds)) return new Date(Number(seconds) * 1000);
  } catch {
    // Checkouts without git history fall back to the current time.
  }
  return new Date();
}

function nightlyVersion() {
  const { version } = JSON.parse(readFileSync('package.json', 'utf8'));
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) {
    throw new Error(`package.json version must be stable SemVer (got: ${version})`);
  }

  const date = commitDate();
  const pad = (value) => String(value).padStart(2, '0');
  // Second resolution so same-minute commits get distinct build versions.
  const stamp = [
    String(date.getUTCFullYear()).slice(-2),
    pad(date.getUTCMonth() + 1),
    pad(date.getUTCDate()),
    pad(date.getUTCHours()),
    pad(date.getUTCMinutes()),
    pad(date.getUTCSeconds()),
  ].join('');

  const [, major, minor, patch] = match;
  return `${major}.${minor}.${Number(patch) + 1}-nightly.${stamp}`;
}

function resolveReleaseMeta({ eventName, inputTag, gitRef, gitRefName, gitSha }) {
  if (eventName === 'workflow_dispatch' && inputTag) {
    return { tag: inputTag, version: inputTag.replace(/^v/, ''), ref: inputTag, nightly: false };
  }
  if (gitRef === 'refs/heads/main') {
    return { tag: 'nightly', version: nightlyVersion(), ref: gitSha, nightly: true };
  }
  if (/^v\d+\./.test(gitRefName)) {
    return { tag: gitRefName, version: gitRefName.replace(/^v/, ''), ref: gitRef, nightly: false };
  }
  throw new Error(`No release target for ref ${gitRef || '<none>'}`);
}

const outputPath = process.argv[2];
if (!outputPath) {
  console.error('Usage: release-meta.mjs <output-file>');
  process.exit(1);
}

try {
  const meta = resolveReleaseMeta({
    eventName: process.env.EVENT_NAME ?? '',
    inputTag: process.env.INPUT_TAG ?? '',
    gitRef: process.env.GIT_REF ?? '',
    gitRefName: process.env.GIT_REF_NAME ?? '',
    gitSha: process.env.GIT_SHA ?? '',
  });

  const entries = Object.entries(meta).map(([key, value]) => `${key}=${value}`);
  appendFileSync(outputPath, `${entries.join('\n')}\n`);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
