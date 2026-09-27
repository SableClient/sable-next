import { execFileSync } from 'node:child_process';
import { copyFile, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const tag = process.argv[2] ?? 'v26.9.0';
const repository = 'https://forgejo.ellis.link/continuwuation/continuwuity.git';
const output = fileURLToPath(
  new URL('../src/lib/features/composer/admin-commands.json', import.meta.url)
);
const dump = fileURLToPath(new URL('./admin-commands-dump.rs', import.meta.url));
const checkout = join(
  process.env.XDG_CACHE_HOME ?? join(homedir(), '.cache'),
  'sable',
  `continuwuity-${tag}`
);

if (!existsSync(checkout)) {
  execFileSync('git', ['clone', '--quiet', '--depth', '1', '--branch', tag, repository, checkout], {
    stdio: 'inherit',
  });
  const manifest = join(checkout, 'xtask/Cargo.toml');
  const xtask = await readFile(manifest, 'utf8');
  await writeFile(
    manifest,
    xtask.replace(
      '[dependencies]\n',
      ['[dependencies]', 'ruma.workspace = true', 'serde_json.workspace = true', ''].join('\n')
    )
  );
}
await mkdir(join(checkout, 'xtask/examples'), { recursive: true });
await copyFile(dump, join(checkout, 'xtask/examples/sable_admin_commands.rs'));

execFileSync(
  'cargo',
  ['build', '--quiet', '-p', 'conduwuit', '-p', 'xtask', '--example', 'sable_admin_commands'],
  { cwd: checkout, stdio: 'inherit' }
);
const tree = JSON.parse(
  execFileSync(join(checkout, 'target/debug/examples/sable_admin_commands'), {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
);

const source = (path) => readFile(join(checkout, path), 'utf8');

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

function restrictedHandlers(text) {
  const names = [];
  let current = null;
  for (const line of text.split('\n')) {
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

const root = { name: 'admin', children: tree };
for (const [module, group] of restrictedGroups(await source('src/admin/admin.rs'))) {
  const node = root.children.find((child) => child.name === group.name);
  if (!node) throw new Error(`no command group ${group.name}`);
  if (group.restricted) {
    markRestricted(node);
    continue;
  }

  const files = (await readdir(join(checkout, 'src/admin', module))).filter((file) =>
    file.endsWith('.rs')
  );
  for (const file of files) {
    const path = `src/admin/${module}/${file}`;
    for (const handler of restrictedHandlers(await source(path))) {
      const matches = findAll(node, handler.replaceAll('_', '-'));
      if (matches.length > 1) {
        throw new Error(`${path}: ${handler} matches ${matches.length} commands`);
      }
      if (matches.length === 0) {
        console.warn(`${path}: ${handler} is not a visible command, skipped`);
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
    ...(node.aliases?.length ? { aliases: node.aliases } : {}),
    ...(node.parameters ? { parameters: node.parameters } : {}),
    ...(node.children ? { children: node.children.map(serialize) } : {}),
  };
}

await writeFile(
  output,
  `${JSON.stringify({ version: tag, commands: root.children.map(serialize) }, null, 2)}\n`
);
