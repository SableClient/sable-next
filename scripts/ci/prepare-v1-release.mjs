#!/usr/bin/env node
import {
  existsSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  mkdirSync,
  renameSync,
} from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const v1Identifier = 'moe.sable.client';

export function prepareV1Release(root) {
  const configPath = join(root, 'src-tauri/tauri.conf.json');
  const config = JSON.parse(readFileSync(configPath, 'utf8'));
  const previous = config.identifier;
  if (![v1Identifier, 'moe.sable.next'].includes(previous))
    throw new Error(
      'Only the development or v1 production identity may be prepared for a stable upgrade'
    );
  const previousPath = previous.replaceAll('.', '/');
  const packagePath = v1Identifier.replaceAll('.', '/');
  const rewrite = (path, transform) => {
    if (existsSync(path)) writeFileSync(path, transform(readFileSync(path, 'utf8')));
  };
  const rewriteTree = (directory) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) rewriteTree(path);
      else if (entry.name.endsWith('.kt'))
        rewrite(path, (text) => text.replaceAll(previous, v1Identifier));
    }
  };
  for (const location of ['app', 'buildSrc']) {
    const base = join(root, `src-tauri/gen/android/${location}/src/main/java`);
    const source = join(base, previousPath);
    const target = join(base, packagePath);
    if (!existsSync(source)) continue;
    if (source !== target && existsSync(target))
      throw new Error('The production Android package path is already occupied');
    rewriteTree(source);
    if (source !== target) {
      mkdirSync(dirname(target), { recursive: true });
      renameSync(source, target);
    }
  }
  rewrite(join(root, 'src-tauri/gen/android/app/build.gradle.kts'), (text) =>
    text.replaceAll(previous, v1Identifier)
  );
  rewrite(join(root, 'src-tauri/src/mobile.rs'), (text) =>
    text
      .replaceAll(
        `Java_${previous.replaceAll('.', '_')}_MainActivity`,
        'Java_moe_sable_client_MainActivity'
      )
      .replaceAll(`${previousPath}/MainActivity`, 'moe/sable/client/MainActivity')
  );
  rewrite(join(root, 'src-tauri/src/main.rs'), (text) =>
    text.replaceAll(`identifier: "${previous}"`, `identifier: "${v1Identifier}"`)
  );
  rewrite(join(root, 'src-tauri/gen/android/app/src/main/res/values/strings.xml'), (text) =>
    text.replaceAll('"sable-next"', '"Sable"')
  );
  config.identifier = v1Identifier;
  config.productName = 'Sable';
  config.mainBinaryName = 'sable';
  config.bundle.longDescription = 'Sable, a Matrix client.';
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
}

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  prepareV1Release(process.cwd());
  console.log('Prepared stable bundles for an in-place Sable v1 upgrade');
}
