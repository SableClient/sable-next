import js from '@eslint/js';
import { defineConfig, globalIgnores } from 'eslint/config';
import globals from 'globals';
import oxlint from 'eslint-plugin-oxlint';
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
    files: ['**/*.svelte'],
    languageOptions: {
      parserOptions: {
        extraFileExtensions: ['.svelte'],
        parser: tseslint.parser,
      },
    },
    rules: {
      'no-undef': 'off',
      'svelte/no-unused-props': 'error',
      'svelte/no-unused-svelte-ignore': 'error',
      'svelte/no-useless-children-snippet': 'error',
      'svelte/no-useless-mustaches': 'error',
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
    // SvelteKit keeps the service worker out of the app's tsconfig, since it
    // compiles against webworker libs rather than the DOM's.
    files: ['src/service-worker.ts'],
    extends: [tseslint.configs.disableTypeChecked],
    languageOptions: {
      parserOptions: { projectService: false, project: false },
      globals: { ...globals.serviceworker },
    },
  },
  {
    files: ['**/*.{js,mjs,cjs}'],
    extends: [tseslint.configs.disableTypeChecked],
  },
  oxlint.configs['flat/recommended'],
]);
