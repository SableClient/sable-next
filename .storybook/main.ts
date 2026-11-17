import type { StorybookConfig } from '@storybook/sveltekit';

const config: StorybookConfig = {
  framework: '@storybook/sveltekit',
  stories: ['../src/lib/ui/**/*.stories.svelte', '../src/lib/features/**/*.stories.svelte'],
  addons: ['@storybook/addon-svelte-csf', '@storybook/addon-docs', '@storybook/addon-a11y'],
  staticDirs: ['../static'],
  viteFinal: (config) => ({
    ...config,
    define: { ...config.define, __SVELTEKIT_PAYLOAD__: '{}' },
  }),
};

export default config;
