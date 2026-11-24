import { readdir, access, mkdtemp } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, sep } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { parseArgs } from 'node:util';
import { SentryCli } from '@sentry/cli';
import { runSentryCli } from './sentry-cli.mjs';

const binaries = ['app', 'sable'];
const addons = ['sable_node.node', 'sable_audiofox.node'];

// The symbol server's breakpad ID is the ELF debug ID without dashes plus a zero age.
export function electronSymbolUrl(debugId) {
  const id = `${debugId.replaceAll('-', '').toUpperCase()}0`;
  return `https://symbols.electronjs.org/electron/${id}/electron.sym`;
}

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

// The check prints its report and then exits 1 for a file it finds unusable.
function inspectFile(path) {
  try {
    return JSON.parse(
      execFileSync(SentryCli.getPath(), ['debug-files', 'check', '--json', path], {
        encoding: 'utf8',
      })
    );
  } catch (error) {
    if (error.status === 1 && error.stdout) return JSON.parse(error.stdout);
    throw error;
  }
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
    options: {
      ios: { type: 'boolean' },
      electron: { type: 'string' },
      'dry-run': { type: 'boolean' },
    },
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
      } else if (process.platform === 'win32' && addons.includes(basename(file))) {
        debugFile = join(dirname(file), basename(file).replace(/\.node$/, '.pdb'));
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
  await uploadDebugFiles(ids, symbols);
  // The mirror depends on symbols.electronjs.org, so a failure there must not
  // block the release; it only leaves Electron's own frames unsymbolicated.
  if (values.electron) {
    try {
      await mirrorElectronSymbols(values.electron);
    } catch (error) {
      console.warn(`::warning::Electron symbols were not mirrored: ${error.message}`);
    }
  }
}

async function uploadDebugFiles(ids, files) {
  const args = ['debug-files', 'upload', '--include-sources', '--wait'];
  for (const id of ids) args.push('--id', id);
  args.push(...files);
  await runSentryCli(args);
}

// Linux ships the Electron binary renamed, and Sentry's built-in Electron
// source looks symbols up by file name, so they are mirrored by debug ID.
async function mirrorElectronSymbols(executable) {
  const [id] = inspectFile(executable).variants.map((variant) => variant.debug_id);
  const url = electronSymbolUrl(id);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Electron symbols unavailable (${response.status}): ${url}`);
  const file = join(await mkdtemp(join(tmpdir(), 'electron-symbols-')), 'electron.sym');
  await pipeline(Readable.fromWeb(response.body), createWriteStream(file));
  if (!(await debugIds(file)).includes(id)) {
    throw new Error(`Debug identifiers do not match: ${executable} and ${url}`);
  }
  await uploadDebugFiles([id], [file]);
}

if (import.meta.main) await main();
