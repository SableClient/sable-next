import { readdir, readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const sourceRoot = join(root, 'src');
const styleExtensions = new Set(['.css', '.svelte']);

// `overlayLayer()` is the only thing that ranks one surface against another.
const bandedLayer = /z-index\s*:[^;}]*var\(\s*--layer-overlay\s*\)[^;}]*[+-][^;}]*[;}]/g;

const surfaces = [
  'Popover',
  'DropdownMenu',
  'ContextMenu',
  'Select',
  'Combobox',
  'Dialog',
  'Menubar',
];

// A story renders a surface inline to show it off, never over another one.
const inlineSurfaces = new Set(['src/lib/ui/primitives/menu.stories.svelte']);

async function sourceFiles(directory) {
  const entries = await readdir(directory, { withFileTypes: true });
  const files = [];

  for (const entry of entries) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) files.push(...(await sourceFiles(path)));
    else if (styleExtensions.has(entry.name.slice(entry.name.lastIndexOf('.')))) files.push(path);
  }

  return files;
}

function lineNumber(source, index) {
  return source.slice(0, index).split('\n').length;
}

const failures = [];
let counted = 0;

for (const file of await sourceFiles(sourceRoot)) {
  const source = await readFile(file, 'utf8');
  const path = relative(root, file).split('\\').join('/');

  for (const match of source.matchAll(bandedLayer)) {
    failures.push(
      `${path}:${lineNumber(source, match.index)}: a surface may not offset --layer-overlay; ` +
        'overlayLayer() raises it above whatever is already open'
    );
  }

  if (!path.endsWith('.svelte') || inlineSurfaces.has(path)) continue;

  for (const surface of surfaces) {
    const opens = [...source.matchAll(new RegExp(`<${surface}\\.Content`, 'g'))];
    counted += opens.length;

    for (const open of opens) {
      const at = `${path}:${lineNumber(source, open.index)}`;
      if (!source.includes(`<${surface}.Portal`)) {
        failures.push(
          `${at}: ${surface}.Content must be inside ${surface}.Portal, or it stacks ` +
            'inside its ancestors rather than over them'
        );
      }
      if (!source.includes('overlayLayer()')) {
        failures.push(
          `${at}: ${surface}.Content must spread overlayLayer(), or it opens under ` +
            'whatever is already open'
        );
      }
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.log(`All ${String(counted)} overlay surfaces are portalled and take a layer on open.`);
}
