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
const literalFontSizePattern = /font-size\s*:\s*(?!\s*(?:var|inherit|max|min|clamp|calc)\b)[^;]+/gi;
const safeAreaPattern = /--safe-(?:top|right|bottom|left)\b/gi;

// An inset must be applied once, by the element that paints under the system
// bar. Everything nested inside one of these already sits in cleared space, so a
// second reference doubles the gap -- which is only visible on a device.
const safeAreaOwners = new Set([
  'src/styles.css',
  'src/lib/ui/MobileNavDrawer.svelte',
  'src/lib/ui/primitives/BottomSheet.svelte',
  'src/lib/ui/primitives/DialogFrame.svelte',
  'src/lib/features/room/MediaViewer.svelte',
  'src/lib/features/auth/flow/AuthFlow.svelte',
]);

// Manually verified dependency-provided properties that source scanning cannot detect.
// --keyboard-height is injected by tauri-plugin-edge-to-edge on Android/iOS.
const externalProperties = new Set([
  '--bits-combobox-anchor-width',
  '--bits-select-anchor-width',
  '--bits-select-content-available-height',
  '--keyboard-height',
]);

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
const literalFontSizes = [];
const safeAreaTrespassers = [];

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

  const path = relative(root, file).split('\\').join('/');
  if (!safeAreaOwners.has(path)) {
    for (const match of source.matchAll(safeAreaPattern)) {
      safeAreaTrespassers.push(`${path}:${lineNumber(source, match.index)} (${match[0]})`);
    }
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
    for (const match of source.matchAll(literalFontSizePattern)) {
      literalFontSizes.push(`${relative(root, file)}:${lineNumber(source, match.index)}`);
    }
  }
}

const missing = [...referenced.keys()]
  .filter((property) => !declared.has(property) && !externalProperties.has(property))
  .sort();

if (
  missing.length > 0 ||
  literalColors.length > 0 ||
  literalFontSizes.length > 0 ||
  safeAreaTrespassers.length > 0
) {
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
  if (literalFontSizes.length > 0) {
    console.error(
      'Literal font-size values are forbidden; use typography tokens from src/styles.css:'
    );
    for (const location of literalFontSizes) console.error(`  ${location}`);
  }
  if (safeAreaTrespassers.length > 0) {
    console.error('Safe-area insets may only be applied by a surface root:');
    for (const owner of [...safeAreaOwners].sort()) console.error(`  owner: ${owner}`);
    for (const location of safeAreaTrespassers) console.error(`  ${location}`);
  }
  process.exitCode = 1;
} else {
  const checked = [...new Set([...declared.keys(), ...referenced.keys()])].sort();
  console.log(`Checked ${checked.length} project custom properties; all references are declared.`);
  console.log(`Safe-area insets are applied only by the ${safeAreaOwners.size} surface roots.`);
}
