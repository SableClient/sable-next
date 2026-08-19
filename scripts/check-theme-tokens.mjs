import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sourceRoot = join(root, 'src');
const sourceExtensions = new Set(['.css', '.svelte', '.ts', '.js', '.mjs']);
const styleExtensions = new Set(['.css', '.svelte']);
const declarationPattern = /(--[a-z0-9_-]+)\s*:/gi;
const runtimeDeclarationPattern = /style:\s*(--[a-z0-9_-]+)\s*=/gi;
const setPropertyPattern = /setProperty\(\s*['"](--[a-z0-9_-]+)['"]/gi;
const variableReferencePattern = /var\(\s*(--[a-z0-9_-]+)/gi;
const literalColorPattern = /(?:#[0-9a-f]{3,8}\b|\b(?:rgb|rgba|hsl|hsla)\s*\()/gi;

// Manually verified dependency-provided properties that source scanning cannot detect.
// --keyboard-height is injected by tauri-plugin-edge-to-edge on Android/iOS.
const externalProperties = new Set(['--bits-combobox-anchor-width', '--keyboard-height']);

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await sourceFiles(path)));
    } else if (sourceExtensions.has(entry.name.slice(entry.name.lastIndexOf('.')))) {
      files.push(path);
    }
  }

  return files;
}

function lineNumber(source, index) {
  return source.slice(0, index).split('\n').length;
}

function addLocation(map, property, file, source, index) {
  const locations = map.get(property) ?? [];
  locations.push(`${relative(root, file)}:${lineNumber(source, index)}`);
  map.set(property, locations);
}

const files = await sourceFiles(sourceRoot);
const declared = new Map();
const referenced = new Map();
const literalColors = [];

for (const file of files) {
  const source = await readFile(file, 'utf8');

  for (const match of source.matchAll(declarationPattern)) {
    const property = match[1].toLowerCase();
    addLocation(declared, property, file, source, match.index);
  }

  for (const match of source.matchAll(runtimeDeclarationPattern)) {
    const property = match[1].toLowerCase();
    addLocation(declared, property, file, source, match.index);
  }

  for (const match of source.matchAll(setPropertyPattern)) {
    const property = match[1].toLowerCase();
    addLocation(declared, property, file, source, match.index);
  }

  for (const match of source.matchAll(variableReferencePattern)) {
    const property = match[1].toLowerCase();
    addLocation(referenced, property, file, source, match.index);
  }

  const isStyleFile = styleExtensions.has(file.slice(file.lastIndexOf('.')));
  if (
    isStyleFile &&
    relative(root, file) !== 'src\\styles.css' &&
    relative(root, file) !== 'src/styles.css'
  ) {
    for (const match of source.matchAll(literalColorPattern)) {
      literalColors.push(`${relative(root, file)}:${lineNumber(source, match.index)}`);
    }
  }
}

const missing = [...referenced.keys()]
  .filter((property) => !declared.has(property) && !externalProperties.has(property))
  .sort();

if (missing.length > 0 || literalColors.length > 0) {
  if (missing.length > 0) {
    console.error('Unknown project custom properties:');
    for (const property of missing) {
      console.error(`  ${property} (${referenced.get(property).join(', ')})`);
    }
  }
  if (literalColors.length > 0) {
    console.error('Literal colors must be declared as theme tokens in src/styles.css:');
    for (const location of literalColors) console.error(`  ${location}`);
  }
  process.exitCode = 1;
} else {
  const checked = [...new Set([...declared.keys(), ...referenced.keys()])].sort();
  console.log(`Checked ${checked.length} project custom properties; all references are declared.`);
}
