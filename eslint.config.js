import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import svelte from 'eslint-plugin-svelte';
import tseslint from 'typescript-eslint';

export default defineConfig([
  globalIgnores([
    'build/**',
    'coverage/**',
    'dist/**',
    'node_modules/**',
    'playwright-report/**',
    'src/generated/**',
    'target/**',
    'target-local/**',
    'test-results/**',
    'wasm/**',
    '.svelte-kit/**',
  ]),
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked,
  svelte.configs.recommended,
  {
    languageOptions: {
      globals: {
        ...globals.browser,
        ...globals.node,
      },
    },
  },
  {
    files: ['**/*.{ts,tsx,mts,cts}'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parserOptions: {
        extraFileExtensions: ['.svelte'],
        parser: tseslint.parser,
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      'svelte/no-unused-props': 'error',
      'svelte/no-unused-svelte-ignore': 'error',
      'svelte/no-useless-children-snippet': 'error',
      'svelte/no-useless-mustaches': 'error',
      'svelte/prefer-const': 'error',
      'svelte/valid-compile': ['error', { ignoreWarnings: false }],
    },
  },
  {
    files: ['**/*.svelte.ts'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    files: ['src/worker/**/*.{ts,js}'],
    languageOptions: {
      globals: {
        ...globals.sharedWorker,
        ...globals.worker,
      },
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
]);
