import type { OxfmtConfig } from 'oxfmt';

export default {
  printWidth: 100,
  tabWidth: 2,
  singleQuote: true,
  trailingComma: 'es5',
  svelte: true,
  ignorePatterns: [
    'dist',
    'node_modules',
    '.svelte-kit',
    'target',
    'src/generated',
    'src-tauri/icons',
    'package.json',
    'pnpm-lock.yaml',
    'Cargo.lock',
    'LICENSE',
    'README.md',
    'CODE_OF_CONDUCT.md',
    'TRADEMARKS.md',
  ],
} satisfies OxfmtConfig;
