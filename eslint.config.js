import { fileURLToPath } from 'node:url';

import js from '@eslint/js';
import { defineConfig, includeIgnoreFile } from 'eslint/config';
import globals from 'globals';
import oxlint from 'eslint-plugin-oxlint';
import svelte from 'eslint-plugin-svelte';
import tseslint from 'typescript-eslint';

const PHOSPHOR_BARREL = {
  name: 'phosphor-svelte',
  allowTypeImports: true,
  message:
    "Import each icon from 'phosphor-svelte/lib/<Name>' so the bundle keeps only the icons it uses.",
};

export default defineConfig([
  includeIgnoreFile(fileURLToPath(new URL('.gitignore', import.meta.url))),
  js.configs.recommended,
  ...tseslint.configs.strict,
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
    // Vite transpiles syntax and never polyfills a built-in.
    files: ['src/**/*.{ts,svelte}'],
    ignores: ['src/**/*.test.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        { property: 'toSorted', message: 'Needs Chrome 110; use .slice().sort().' },
        { property: 'toReversed', message: 'Needs Chrome 110; use .slice().reverse().' },
        { property: 'toSpliced', message: 'Needs Chrome 110.' },
        { property: 'with', message: 'Needs Chrome 110; use .map() or a copy.' },
        { property: 'findLast', message: 'Needs Chrome 97; walk the array backwards.' },
        { property: 'findLastIndex', message: 'Needs Chrome 97; walk the array backwards.' },
        { object: 'Object', property: 'groupBy', message: 'Needs Chrome 117.' },
      ],
      'no-alert': 'error',
      'no-restricted-imports': ['error', { paths: [PHOSPHOR_BARREL] }],
      'no-restricted-globals': [
        'error',
        { name: 'structuredClone', message: 'Needs Chrome 98; use a JSON round trip.' },
      ],
    },
  },
  {
    files: ['src/lib/**/*.{ts,svelte}'],
    ignores: ['src/lib/features/**', 'src/lib/**/*.test.ts', 'src/lib/**/*.test.svelte'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          paths: [PHOSPHOR_BARREL],
          patterns: [
            {
              group: ['#lib/features/*', '**/features/*'],
              message: 'Shared lib must not import from a feature; move the module down instead.',
            },
          ],
        },
      ],
    },
  },
  {
    files: ['**/*.svelte'],
    languageOptions: {
      parserOptions: {
        extraFileExtensions: ['.svelte'],
        parser: tseslint.parser,
        svelteConfig: { compilerOptions: { experimental: { async: true } } },
      },
    },
    rules: {
      'no-undef': 'off',
      'svelte/prefer-const': 'error',
      'svelte/valid-compile': ['error', { ignoreWarnings: false }],

      // `on()` hands back its own unsubscriber, so teardown cannot be forgotten.
      'svelte/no-add-event-listener': 'error',
      'svelte/button-has-type': 'error',
      'svelte/no-ignored-unsubscribe': 'error',
      'svelte/no-target-blank': 'error',
      // Nothing here may read `window`/`document` at module scope: `ssr` is off,
      // but the modules are still evaluated in node when prerendering the shell.
      'svelte/no-top-level-browser-globals': 'error',
      'svelte/prefer-derived-over-derived-by': 'error',
      'svelte/block-lang': ['error', { script: 'ts' }],
      'svelte/no-bind-value-on-checkable-inputs': 'error',
      'svelte/no-conflicting-module-names': 'error',
      'svelte/no-nested-style-tag': 'error',
      'svelte/require-event-prefix': 'error',
      'svelte/valid-style-parse': 'error',
    },
  },
  {
    files: ['**/*.svelte.ts'],
    languageOptions: {
      parser: tseslint.parser,
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
    files: ['src/lib/platform/*-worklet.js'],
    languageOptions: { globals: { ...globals.audioWorklet } },
  },
  {
    files: ['src/service-worker/**/*.ts'],
    languageOptions: {
      globals: { ...globals.serviceworker },
    },
  },
  {
    files: ['tests/e2e/**/*.ts'],
    ignores: ['tests/e2e/fixtures/settle.ts'],
    rules: {
      'no-restricted-properties': [
        'error',
        {
          property: 'waitForTimeout',
          message: 'Wait on a condition, or name the window in fixtures/settle.ts.',
        },
      ],
    },
  },
  ...oxlint.buildFromOxlintConfigFile('./.oxlintrc.json'),
]);
