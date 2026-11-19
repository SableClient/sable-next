import { withThemeByClassName } from '@storybook/addon-themes';
import type { Decorator, Preview, SvelteRenderer } from '@storybook/sveltekit';

import '../src/styles.css';

import CoreClientProvider from './CoreClientProvider.svelte';

const provideCoreClient: Decorator = (story) => ({
  Component: CoreClientProvider,
  props: { children: story },
});

const preview: Preview = {
  decorators: [
    withThemeByClassName<SvelteRenderer>({
      themes: { light: 'light', dark: 'dark' },
      defaultTheme: 'light',
    }),
    provideCoreClient,
  ],
  parameters: {
    backgrounds: { disable: true },
    controls: { expanded: true, sort: 'requiredFirst' },
    a11y: { test: 'error' },
  },
};

export default preview;
