import type { OxfmtConfig } from 'oxfmt';

export default {
  printWidth: 100,
  tabWidth: 2,
  singleQuote: true,
  trailingComma: 'es5',
  svelte: true,
  ignorePatterns: [
    '.agents/skills',
    '.impeccable',
    'vendor',
    'plugins/tauri-plugin-sable-push/permissions',
    'src/generated',
    // Written by the runtime's wire golden test.
    'tests/fixtures/wire',
    'src-tauri/icons',
    // Handlebars behind a .yml extension; oxfmt parses it as YAML and fails.
    'src-tauri/ios-project.yml',
    'package.json',
    'CHANGELOG.md',
    'src-tauri/tauri.conf.json',
    'Cargo.lock',
    'LICENSE',
    'README.md',
    'CODE_OF_CONDUCT.md',
    'TRADEMARKS.md',
  ],
} satisfies OxfmtConfig;
