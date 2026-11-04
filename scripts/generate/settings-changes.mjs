import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ts from 'typescript';
import {
  git,
  output,
  releaseChanges,
  releaseCount,
  releaseTags,
  root,
} from '../release/settings-changes-release.mjs';

const registryDir = 'src/lib/settings/registry';

function readSources(rev) {
  const paths =
    rev === null
      ? readdirSync(join(root, registryDir)).map((name) => `${registryDir}/${name}`)
      : git('ls-tree', '--name-only', rev, `${registryDir}/`).split('\n').filter(Boolean);
  paths.push('src/lib/settings/registry.ts', 'src/lib/settings/preferences.svelte.ts');
  return paths.map((path) => ({
    path,
    text: rev === null ? readFileSync(join(root, path), 'utf8') : git('show', `${rev}:${path}`),
  }));
}

const propertyName = (property) =>
  property.name && ts.isIdentifier(property.name) ? property.name.text : undefined;

export function parseSettings(sources) {
  const keys = new Set();
  const defaults = {};
  for (const { path, text } of sources) {
    const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
    const visit = (node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const key = node.properties.find((property) => propertyName(property) === 'key');
        const hasName = node.properties.some((property) => propertyName(property) === 'name');
        if (hasName && key && ts.isStringLiteralLike(key.initializer))
          keys.add(key.initializer.text);
      }
      if (
        ts.isVariableDeclaration(node) &&
        node.name.getText() === 'DEFAULTS' &&
        node.initializer
      ) {
        for (const property of node.initializer.properties) {
          defaults[property.name.getText()] = property.initializer.getText().replace(/\s+/g, ' ');
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(file);
  }
  return { keys: [...keys], defaults };
}

export function diffSettings(before, after) {
  const known = new Set(before.keys);
  const added = after.keys.filter((key) => !known.has(key));
  const changed = after.keys
    .filter((key) => known.has(key) && key in before.defaults && key in after.defaults)
    .filter((key) => before.defaults[key] !== after.defaults[key])
    .map((key) => ({ key, from: before.defaults[key], to: after.defaults[key] }));
  return { added, changed };
}

export function buildChanges(tags, load) {
  const releases = tags.slice(-releaseCount - 1);
  const sections = [
    ['upcoming', tags.at(-1), null],
    ...releases
      .slice(1)
      .map((tag, index) => [tag, releases[index], tag])
      .reverse(),
  ];
  const changes = {};
  for (const [name, from, to] of sections) {
    const { added, changed } = diffSettings(load(from), load(to));
    if (added.length > 0 || changed.length > 0) changes[name] = { added, changed };
  }
  return changes;
}

if (import.meta.main) {
  const check = process.argv.includes('--check');
  const tags = releaseTags();
  if (tags.length <= releaseCount) {
    throw new Error('Release tags are missing, fetch them with git fetch --tags');
  }
  let changes = buildChanges(tags, (rev) => parseSettings(readSources(rev)));
  const { version } = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  // A prepared release is not tagged until its PR merges.
  if (!tags.includes(`v${version}`)) changes = releaseChanges(changes, version, tags);
  const json = `${JSON.stringify(changes, null, 2)}\n`;
  if (!check) writeFileSync(output, json);
  else if (readFileSync(output, 'utf8') !== json) {
    console.error('settings-changes.json is stale, run mise run generate:settings-changes');
    process.exit(1);
  }
}
