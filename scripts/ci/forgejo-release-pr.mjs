#!/usr/bin/env node

import { readFileSync } from 'node:fs';
import process from 'node:process';

const server = (process.env.FORGEJO_URL ?? 'https://git.sable.moe').replace(/\/+$/, '');
const repository = process.env.FORGEJO_REPOSITORY ?? 'SableClient/sable-next';
const api = `${server}/api/v1/repos/${repository}`;
const { version } = JSON.parse(readFileSync('package.json', 'utf8'));

async function request(method, path, body) {
  const response = await fetch(`${api}${path}`, {
    method,
    headers: {
      Authorization: `token ${process.env.FORGEJO_TOKEN}`,
      'Content-Type': 'application/json',
    },
    body: body && JSON.stringify(body),
  });
  if (response.status === 404 && method === 'GET') return undefined;
  if (!response.ok) {
    throw new Error(`${method} ${path} failed: ${response.status} ${await response.text()}`);
  }
  return response.json();
}

function changelogEntry() {
  const lines = readFileSync('CHANGELOG.md', 'utf8').split('\n');
  const start = lines.findIndex((line) => line.startsWith(`## ${version} `));
  if (start === -1) throw new Error(`CHANGELOG.md has no entry for ${version}`);
  const next = lines.findIndex((line, index) => index > start && line.startsWith('## '));
  return lines
    .slice(start + 1, next === -1 ? undefined : next)
    .join('\n')
    .trim();
}

async function pullRequest() {
  const title = `chore: prepare release ${version}`;
  const body = `> [!IMPORTANT]\n> Merging this PR will create a new release.\n\n${changelogEntry()}`;
  const open = await request('GET', '/pulls?state=open&base=main&limit=50');
  const existing = open.find((pull) => pull.head.ref === 'release');
  if (existing) {
    await request('PATCH', `/pulls/${existing.number}`, { title, body });
    console.log(`Updated pull request #${existing.number}.`);
  } else {
    const created = await request('POST', '/pulls', { head: 'release', base: 'main', title, body });
    console.log(`Created pull request #${created.number}.`);
  }
}

async function release() {
  const tag = `v${version}`;
  if (await request('GET', `/releases/tags/${tag}`)) {
    console.log(`Release ${tag} already exists.`);
    return;
  }
  await request('POST', '/releases', {
    tag_name: tag,
    target_commitish: 'main',
    name: tag,
    body: changelogEntry(),
  });
  console.log(`Created release ${tag}.`);
}

const commands = { pr: pullRequest, release };
const run = commands[process.argv[2]];
if (!run) {
  console.error('Usage: forgejo-release-pr.mjs <pr|release>');
  process.exit(1);
}

try {
  await run();
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
