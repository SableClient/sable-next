import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';

const tag = process.argv[2] ?? 'v26.9.0';
const api = 'https://forgejo.ellis.link/api/v1/repos/continuwuation/continuwuity';
const output = fileURLToPath(
  new URL('../src/lib/features/composer/admin-commands.json', import.meta.url)
);

async function fetchText(path) {
  const response = await fetch(`${api}/raw/${path}?ref=${tag}`);
  if (!response.ok) throw new Error(`${path}@${tag}: ${response.status}`);
  return response.text();
}

async function listDir(path) {
  const response = await fetch(`${api}/contents/${path}?ref=${tag}`);
  if (!response.ok) throw new Error(`${path}@${tag}: ${response.status}`);
  return response.json();
}

function parseReference(markdown, root) {
  const lines = markdown.split('\n');
  for (let index = 0; index < lines.length; index += 1) {
    const heading = /^#+ `!admin ([a-z0-9 -]+)`$/.exec(lines[index]);
    if (!heading) continue;

    const paragraph = [];
    let cursor = index + 1;
    while (cursor < lines.length && lines[cursor].trim() === '') cursor += 1;
    while (cursor < lines.length && lines[cursor].trim() !== '' && !lines[cursor].startsWith('#')) {
      paragraph.push(lines[cursor].trim());
      cursor += 1;
    }

    let node = root;
    for (const name of heading[1].split(' ')) {
      node.children ??= [];
      let child = node.children.find((candidate) => candidate.name === name);
      if (!child) {
        child = { name, description: '' };
        node.children.push(child);
      }
      node = child;
    }
    node.description = paragraph.join(' ');
  }
}

function restrictedGroups(adminRs) {
  const groups = new Map();
  for (const arm of adminRs.split(/\n\t\t\| /).slice(1)) {
    const match = /^([A-Z][A-Za-z]*)\(command\) => \{?[\s\S]*?(\w+)::process/.exec(arm);
    if (!match) continue;
    groups.set(match[2], {
      name: match[1].toLowerCase(),
      restricted: /bail_restricted\(\)/.test(arm.split('::process')[0]),
    });
  }
  return groups;
}

function restrictedHandlers(source) {
  const names = [];
  let current = null;
  for (const line of source.split('\n')) {
    const handler = /async fn (\w+)/.exec(line);
    if (handler) current = handler[1];
    if (current && /self\.bail_restricted\(\)/.test(line)) names.push(current);
  }
  return names;
}

function findAll(node, name) {
  const matches = [];
  for (const child of node.children ?? []) {
    if (child.name === name && !child.children) matches.push(child);
    matches.push(...findAll(child, name));
  }
  return matches;
}

function markRestricted(node) {
  node.restricted = true;
  for (const child of node.children ?? []) markRestricted(child);
}

const root = { name: 'admin', description: '' };
for (const entry of await listDir('docs/reference/admin')) {
  if (entry.name === 'index.md') continue;
  parseReference(await fetchText(entry.path), root);
}

const groups = restrictedGroups(await fetchText('src/admin/admin.rs'));
for (const [module, group] of groups) {
  const node = root.children.find((child) => child.name === group.name);
  if (!node) throw new Error(`no reference for group ${group.name}`);
  if (group.restricted) {
    markRestricted(node);
    continue;
  }

  const files = (await listDir(`src/admin/${module}`)).filter((file) => file.name.endsWith('.rs'));
  for (const file of files) {
    for (const handler of restrictedHandlers(await fetchText(file.path))) {
      const matches = findAll(node, handler.replaceAll('_', '-'));
      if (matches.length > 1) {
        throw new Error(`${file.path}: ${handler} matches ${matches.length} commands`);
      }
      if (matches.length === 0) {
        console.warn(`${file.path}: ${handler} is not in the reference, skipped`);
        continue;
      }
      matches[0].restricted = true;
    }
  }
}

function serialize(node) {
  return {
    name: node.name,
    description: node.description,
    ...(node.restricted ? { restricted: true } : {}),
    ...(node.children ? { children: node.children.map(serialize) } : {}),
  };
}

await writeFile(
  output,
  `${JSON.stringify({ version: tag, commands: root.children.map(serialize) }, null, 2)}\n`
);
