import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const extensions = new Set(['.svelte', '.ts', '.js', '.mjs']);
const pluralSuffix = /_(?:zero|one|two|few|many|other)$/;
const literalPattern = /['"`]([A-Za-z][\w]*(?:\.[\w]+)+)['"`]/g;
const prefixPattern = /['"`]([A-Za-z][\w]*\.[\w.]*)(?:\$\{|['"`]\s*\+)/g;

function flatten(node, prefix = '') {
  return Object.entries(node).flatMap(([key, value]) =>
    typeof value === 'string' ? [prefix + key] : flatten(value, `${prefix}${key}.`)
  );
}

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];
  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'locales' || entry.name === 'generated') continue;
      files.push(...(await sourceFiles(path)));
    } else if ([...extensions].some((extension) => entry.name.endsWith(extension))) {
      files.push(path);
    }
  }
  return files;
}

const english = JSON.parse(await readFile(join(root, 'src/locales/en.json'), 'utf8'));
const keys = new Set(flatten(english).map((key) => key.replace(pluralSuffix, '')));

const literals = new Set();
const prefixes = new Set();

for (const file of [
  ...(await sourceFiles(join(root, 'src'))),
  ...(await sourceFiles(join(root, 'tests'))),
]) {
  const text = await readFile(file, 'utf8');
  for (const [, prefix] of text.matchAll(prefixPattern)) prefixes.add(prefix);
  for (const [, literal] of text.matchAll(literalPattern)) {
    literals.add(literal.replace(pluralSuffix, ''));
  }
}

const unused = [...keys].filter(
  (key) => !literals.has(key) && ![...prefixes].some((prefix) => key.startsWith(prefix))
);

if (unused.length > 0) {
  console.error(
    `Unused locale keys in src/locales/en.json:\n${unused.map((key) => `  ${key}`).join('\n')}`
  );
}
if (unused.length > 0) process.exit(1);
console.log(`Locale keys: all ${keys.size} are referenced.`);
