import { fileURLToPath } from 'node:url';
import type { StorybookConfig } from '@storybook/sveltekit';
import { mergeConfig } from 'vite';

const config: StorybookConfig = {
  framework: '@storybook/sveltekit',
  stories: ['../src/lib/ui/**/*.stories.svelte', '../src/lib/features/**/*.stories.svelte'],
  addons: [
    '@storybook/addon-svelte-csf',
    '@storybook/addon-docs',
    '@storybook/addon-a11y',
    '@storybook/addon-vitest',
  ],
  staticDirs: ['../static'],
  viteFinal: (config) =>
    mergeConfig(config, {
      define: { __SVELTEKIT_PAYLOAD__: '{}' },
      resolve: {
        alias: [
          {
            find: /^#src\/generated\/wasm\/sable_model(\.js|_bg\.wasm\?url)$/,
            replacement: fileURLToPath(new URL('model-stub.ts', import.meta.url)),
          },
          {
            find: /^(#lib\/platform|\.)\/overlay-back\.svelte\.js$/,
            replacement: fileURLToPath(new URL('overlay-back-stub.ts', import.meta.url)),
          },
        ],
      },
    }),
};

export default config;
