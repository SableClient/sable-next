#!/usr/bin/env node

import { openAsBlob, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import process from 'node:process';

const server = (process.env.FORGEJO_URL ?? 'https://git.sable.moe').replace(/\/+$/, '');
const repository = process.env.FORGEJO_REPOSITORY ?? 'SableClient/sable-next';
const token = process.env.FORGEJO_TOKEN;
const api = `${server}/api/v1/repos/${repository}`;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function request(method, path, { body, headers = {}, allow404 = false } = {}) {
  if (!token) throw new Error('FORGEJO_TOKEN is required');
  const response = await fetch(`${api}${path}`, {
    method,
    headers: { Authorization: `token ${token}`, ...headers },
    body,
  });
  if (response.status === 404 && allow404) return undefined;
  if (!response.ok) {
    throw new Error(`${method} ${path} failed: ${response.status} ${await response.text()}`);
  }
  if (response.status === 204) return undefined;
  const text = await response.text();
  return text ? JSON.parse(text) : undefined;
}

const json = (value) => ({
  body: JSON.stringify(value),
  headers: { 'Content-Type': 'application/json' },
});

const getRelease = (tag) =>
  request('GET', `/releases/tags/${encodeURIComponent(tag)}`, { allow404: true });

async function requireRelease(tag) {
  const release = await getRelease(tag);
  if (!release) throw new Error(`Release ${tag} does not exist`);
  return release;
}

async function ensureRelease(tag, { sha, title, notes, prerelease }) {
  const existing = await getRelease(tag);
  if (existing) {
    console.log(`Reusing the existing ${tag} release.`);
    return existing;
  }
  const created = await request(
    'POST',
    '/releases',
    json({
      tag_name: tag,
      target_commitish: sha,
      name: title ?? tag,
      body: notes ?? '',
      draft: false,
      prerelease: Boolean(prerelease),
    })
  );
  console.log(`Created release ${tag}.`);
  return created;
}

async function waitForRelease(tag, attempts, intervalMs) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const release = await getRelease(tag);
    if (release) {
      console.log(`Release ${tag} found.`);
      return release;
    }
    console.log(`Waiting for release ${tag} to be published (${attempt}/${attempts})…`);
    await sleep(intervalMs);
  }
  throw new Error(`Release ${tag} was not found.`);
}

async function uploadAssets(tag, files) {
  const release = await requireRelease(tag);
  for (const file of files) {
    const name = basename(file);
    const stale = release.assets?.find((asset) => asset.name === name);
    if (stale) await request('DELETE', `/releases/${release.id}/assets/${stale.id}`);

    const form = new FormData();
    form.append('attachment', await openAsBlob(file), name);
    await request('POST', `/releases/${release.id}/assets?name=${encodeURIComponent(name)}`, {
      body: form,
    });
    console.log(`Uploaded ${name}`);
  }
}

async function listAssets(tag) {
  const release = await getRelease(tag);
  return release?.assets ?? [];
}

async function downloadAssets(tag, pattern, directory) {
  const matcher = new RegExp(
    `^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`
  );
  const assets = (await listAssets(tag)).filter((asset) => matcher.test(asset.name));
  for (const asset of assets) {
    const response = await fetch(asset.browser_download_url, {
      headers: { Authorization: `token ${token}` },
    });
    if (!response.ok) throw new Error(`Downloading ${asset.name} failed: ${response.status}`);
    writeFileSync(join(directory, asset.name), Buffer.from(await response.arrayBuffer()));
    console.log(`Downloaded ${asset.name}`);
  }
}

async function findPrevious(assetName, excludeTag) {
  const releases = await request('GET', '/releases?limit=100');
  for (const release of releases ?? []) {
    if (release.draft || release.prerelease) continue;
    if (release.tag_name === excludeTag) continue;
    if (release.assets?.some((asset) => asset.name === assetName)) return release.tag_name;
  }
  return '';
}

async function deleteAsset(tag, name) {
  const release = await requireRelease(tag);
  const asset = release.assets?.find((candidate) => candidate.name === name);
  if (!asset) return;
  await request('DELETE', `/releases/${release.id}/assets/${asset.id}`);
  console.log(`Removed ${name}`);
}

async function editRelease(tag, { title, notes, prerelease }) {
  const release = await requireRelease(tag);
  await request(
    'PATCH',
    `/releases/${release.id}`,
    json({
      ...(title !== undefined && { name: title }),
      ...(notes !== undefined && { body: notes }),
      ...(prerelease !== undefined && { prerelease }),
    })
  );
  console.log(`Updated release ${tag}.`);
}

async function waitForAssets(tag, names, attempts, intervalMs) {
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const present = new Set((await listAssets(tag)).map((asset) => asset.name));
    const missing = names.filter((name) => !present.has(name));
    if (missing.length === 0) {
      console.log(`All ${names.length} expected asset(s) are present.`);
      return;
    }
    console.log(`Waiting for ${missing.join(', ')} (${attempt}/${attempts})…`);
    await sleep(intervalMs);
  }
  throw new Error(`Timed out waiting for: ${names.join(', ')}`);
}

function parseFlags(argv) {
  const flags = {};
  const rest = [];
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument.startsWith('--')) {
      const [key, inline] = argument.slice(2).split('=');
      if (inline !== undefined) flags[key] = inline;
      else if (argv[index + 1] && !argv[index + 1].startsWith('--')) flags[key] = argv[++index];
      else flags[key] = 'true';
    } else {
      rest.push(argument);
    }
  }
  return { flags, rest };
}

const [command, ...argv] = process.argv.slice(2);
const { flags, rest } = parseFlags(argv);
const tag = flags.tag ?? process.env.TAG;
const attempts = Number(flags.attempts ?? 60);
const interval = Number(flags.interval ?? 15) * 1000;

try {
  switch (command) {
    case 'ensure':
      await ensureRelease(tag, {
        sha: flags.sha,
        title: flags.title,
        notes: flags.notes,
        prerelease: flags.prerelease === 'true',
      });
      break;
    case 'wait':
      await waitForRelease(tag, attempts, interval);
      break;
    case 'wait-assets':
      await waitForAssets(tag, flags.names.split(',').filter(Boolean), attempts, interval);
      break;
    case 'upload':
      await uploadAssets(tag, rest);
      break;
    case 'assets':
      console.log((await listAssets(tag)).map((asset) => asset.name).join('\n'));
      break;
    case 'download':
      await downloadAssets(tag, flags.pattern, flags.dir ?? '.');
      break;
    case 'delete-asset':
      await deleteAsset(tag, flags.name);
      break;
    case 'edit':
      await editRelease(tag, {
        title: flags.title,
        notes: flags.notes,
        ...(flags.prerelease !== undefined && { prerelease: flags.prerelease === 'true' }),
      });
      break;
    case 'find-previous':
      console.log(await findPrevious(flags.asset, tag));
      break;
    case 'body':
      console.log((await requireRelease(tag)).body ?? '');
      break;
    default:
      console.error(
        'Usage: forgejo-release.mjs <ensure|wait|wait-assets|upload|assets|download|delete-asset|find-previous|edit|body> [flags]'
      );
      process.exit(1);
  }
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
