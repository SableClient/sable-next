import { readdir, access } from 'node:fs/promises';
import { basename, dirname, join, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { parseArgs } from 'node:util';
import { SentryCli } from '@sentry/cli';

const binaries = ['app', 'sable'];
const addons = ['sable_node.node', 'sable_audiofox.node'];

export async function collectSymbols(root) {
  const symbols = [];
  const ignored = new Set(['deps', 'incremental', 'debug', 'bundle']);
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) {
        if (entry.name.endsWith('.dSYM')) {
          if (!entry.name.endsWith('.framework.dSYM')) symbols.push(path);
        } else if (
          !ignored.has(entry.name) &&
          !(entry.name === 'build' && basename(directory) === 'release')
        )
          await visit(path);
      } else if (
        entry.isFile() &&
        [
          ...binaries,
          ...binaries.map((name) => `${name}.exe`),
          ...binaries.map((name) => `${name}.pdb`),
          'libapp_lib.so',
          ...addons,
        ].includes(entry.name)
      ) {
        symbols.push(path);
      }
    }
  }
  await visit(root);
  return symbols;
}

function inspectFile(path) {
  return JSON.parse(
    execFileSync(SentryCli.getPath(), ['debug-files', 'check', '--json', path], {
      encoding: 'utf8',
    })
  );
}

async function debugIds(path) {
  const dwarf = join(path, 'Contents/Resources/DWARF');
  const files = path.endsWith('.dSYM')
    ? (await readdir(dwarf)).map((name) => join(dwarf, name))
    : [path];
  const ids = [];
  for (const file of files) {
    const report = inspectFile(file);
    if (!report.is_usable || !report.features?.split(', ').includes('debug')) {
      throw new Error(`Missing usable debug information: ${file}`);
    }
    // In-process SDKs such as sentry-rust leave ELF images without a build ID out of events.
    if (report.type === 'elf' && report.variants.some((variant) => !variant.code_id)) {
      throw new Error(`Missing build ID: ${file}`);
    }
    ids.push(...report.variants.map((variant) => variant.debug_id).filter(Boolean));
  }
  if (ids.length === 0) throw new Error(`Missing debug identifiers: ${path}`);
  return ids;
}

async function main() {
  const { values, positionals } = parseArgs({
    options: { ios: { type: 'boolean' }, 'dry-run': { type: 'boolean' } },
    allowPositionals: true,
  });
  if (!process.env.VITE_SENTRY_DSN && !values['dry-run']) return;
  if (!values['dry-run']) {
    for (const name of ['SENTRY_AUTH_TOKEN', 'SENTRY_ORG', 'SENTRY_PROJECT']) {
      if (!process.env[name]) throw new Error(`${name} is required for native symbol uploads`);
    }
  }
  const roots = positionals.length
    ? positionals
    : [values.ios ? 'src-tauri/gen/apple' : (process.env.CARGO_TARGET_DIR ?? 'target')];
  const symbols = new Set();
  const ids = new Set();
  for (const root of roots) {
    const files = await collectSymbols(root);
    if (files.length === 0) throw new Error(`No native symbols found: ${root}`);
    if (values.ios && !files.some((path) => path.endsWith('.app.dSYM'))) {
      throw new Error(`Missing iOS app dSYM: ${root}`);
    }
    const dsyms = new Set(files.filter((path) => path.endsWith('.dSYM')));
    for (const file of files) {
      let debugFile = file;
      if (file.endsWith('.exe')) {
        debugFile = join(dirname(file), 'app.pdb');
        await access(debugFile);
      } else if (
        process.platform === 'darwin' &&
        [...binaries, ...addons].includes(basename(file))
      ) {
        debugFile = join(
          dirname(file),
          addons.includes(basename(file)) ? `${basename(file)}.dSYM` : 'app.dSYM'
        );
        if (!dsyms.has(debugFile)) {
          if (file.split(sep).includes('universal-apple-darwin')) continue;
          execFileSync('dsymutil', [file, '-o', debugFile], { stdio: 'inherit' });
        }
      }
      const fileIds = await debugIds(debugFile);
      if (file !== debugFile) {
        const binaryIds = inspectFile(file).variants.map((variant) => variant.debug_id);
        if (binaryIds.length === 0 || binaryIds.some((id) => !fileIds.includes(id))) {
          throw new Error(`Debug identifiers do not match: ${file} and ${debugFile}`);
        }
      }
      for (const id of fileIds) ids.add(id);
      symbols.add(file);
      symbols.add(debugFile);
    }
  }
  if (values['dry-run']) {
    console.info(`Validated ${ids.size} debug identifiers in ${symbols.size} native symbol files`);
    return;
  }
  const args = ['debug-files', 'upload', '--include-sources', '--wait'];
  for (const id of ids) args.push('--id', id);
  args.push(...symbols);
  execFileSync(SentryCli.getPath(), args, { stdio: 'inherit' });
}

if (import.meta.main) await main();
