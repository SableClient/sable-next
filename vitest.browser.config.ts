import { playwright } from '@vitest/browser-playwright';
import { mergeConfig } from 'vite';
import { defineConfig } from 'vitest/config';

import viteConfig from './vite.config.ts';

export default mergeConfig(
  viteConfig,
  defineConfig({
    optimizeDeps: { include: ['katex'] },
    test: {
      name: 'browser',
      include: ['src/**/*.browser.test.ts'],
      setupFiles: ['./vitest-browser-setup.ts'],
      browser: {
        enabled: true,
        headless: true,
        provider: playwright(),
        instances: [{ browser: 'chromium' }],
      },
    },
  })
);
