import { execFileSync } from 'node:child_process';
import { join } from 'node:path';

const root = join(import.meta.dirname, '../..');

// Workspace crates a crate may depend on. A crate missing from this table, or
// an edge missing from its row, fails the check: add it here deliberately.
const allowed = {
  'sable-protocol': ['sable-model'],
  'sable-model': [],
  'sable-runtime': ['sable-protocol'],
  'sable-ffi': ['sable-protocol', 'sable-runtime'],
  'sable-core': ['sable-model', 'sable-protocol', 'sable-runtime'],
  'sable-model-wasm': ['sable-model'],
  'sable-hdr': [],
  'sable-loopback': [],
  'tauri-plugin-sable-push': [],
  'sable-push': ['sable-core'],
  'sable-wasm': ['sable-core', 'sable-ffi', 'sable-protocol', 'sable-runtime'],
  'sable-node': ['sable-core', 'sable-ffi', 'sable-loopback', 'sable-protocol', 'sable-runtime'],
  app: [
    'sable-core',
    'sable-ffi',
    'sable-hdr',
    'sable-loopback',
    'sable-protocol',
    'sable-runtime',
    'tauri-plugin-sable-push',
  ],
};

// Only these crates may name the Matrix SDK, directly or through a feature.
const sdkOwners = new Set(['sable-core']);
const isSdk = (name) => name.startsWith('matrix-sdk');

const metadata = JSON.parse(
  execFileSync('cargo', ['metadata', '--format-version', '1', '--no-deps', '--locked'], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  })
);

const members = new Set(metadata.packages.map((pkg) => pkg.name));
const failures = [];

for (const pkg of metadata.packages) {
  const row = allowed[pkg.name];
  if (!row) {
    failures.push(`${pkg.name}: not in the edge table of scripts/check/crate-edges.mjs`);
    continue;
  }
  for (const dependency of pkg.dependencies) {
    if (isSdk(dependency.name) && !sdkOwners.has(pkg.name)) {
      failures.push(`${pkg.name}: depends on ${dependency.name}; only sable-core may`);
    }
    if (members.has(dependency.name) && !row.includes(dependency.name)) {
      failures.push(
        `${pkg.name}: depends on ${dependency.name}, which is not in its allowed edges`
      );
    }
  }
}

if (failures.length > 0) {
  for (const failure of failures) console.error(failure);
  process.exitCode = 1;
} else {
  console.log(`All ${String(members.size)} workspace crates stay within their allowed edges.`);
}
