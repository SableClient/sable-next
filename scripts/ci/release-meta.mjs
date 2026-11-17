import { execSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { nextCalver } from '../lib/calver.mjs';

// The setup-release job installs no packages, so this cannot use `semver`.
const IDENTIFIER = '(?:0|[1-9]\\d*|\\d*[a-zA-Z-][0-9a-zA-Z-]*)';
const RELEASE_TAG = new RegExp(
  `^v?(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)\\.(?:0|[1-9]\\d*)` +
    `(?:-${IDENTIFIER}(?:\\.${IDENTIFIER})*)?(?:\\+[0-9a-zA-Z-]+(?:\\.[0-9a-zA-Z-]+)*)?$`
);

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

function nightlyVersion(version, gitSha, date) {
  const day = date.getUTCDate();
  const time = date.getUTCHours() * 100 + date.getUTCMinutes();
  return `${nextCalver(version, date)}-nightly.${day}.${time}.g${gitSha.slice(0, 6)}`;
}

function resolveReleaseMeta({ eventName, inputTag, gitRef, gitRefName, gitSha }) {
  if (eventName === 'workflow_dispatch' && inputTag) {
    if (!RELEASE_TAG.test(inputTag)) throw new Error(`Invalid release tag: ${inputTag}`);
    return {
      tag: inputTag,
      version: inputTag.replace(/^v/, ''),
      ref: inputTag,
      sha: gitSha,
      nightly: false,
    };
  }
  if (gitRef === 'refs/heads/main') {
    if (!/^[0-9a-f]{12,}$/i.test(gitSha)) {
      throw new Error('GIT_SHA must contain at least 12 hexadecimal characters for nightly builds');
    }
    const { version: current } = JSON.parse(readFileSync('package.json', 'utf8'));
    const version = nightlyVersion(current, gitSha, commitDate());
    return { tag: `nightly-${version}`, version, ref: gitSha, sha: gitSha, nightly: true };
  }
  if (gitRefName.startsWith('v') && RELEASE_TAG.test(gitRefName)) {
    return {
      tag: gitRefName,
      version: gitRefName.replace(/^v/, ''),
      ref: gitRef,
      sha: gitSha,
      nightly: false,
    };
  }
  throw new Error(`No release target for ref ${gitRef || '<none>'}`);
}

const outputPath = process.argv[2];
if (!outputPath) {
  console.error('Usage: release-meta.mjs <output-file>');
  process.exit(1);
}

const meta = resolveReleaseMeta({
  eventName: process.env.EVENT_NAME ?? '',
  inputTag: process.env.INPUT_TAG ?? '',
  gitRef: process.env.GIT_REF ?? '',
  gitRefName: process.env.GIT_REF_NAME ?? '',
  gitSha: process.env.GIT_SHA ?? '',
});

const entries = Object.entries(meta).map(([key, value]) => `${key}=${value}`);
appendFileSync(outputPath, `${entries.join('\n')}\n`);
