import { mergeConfig } from 'vite';
import { defineConfig } from 'vitest/config';

import viteConfig from './vite.config.ts';

export default mergeConfig(
  viteConfig,
  defineConfig({
    resolve: process.env.VITEST ? { conditions: ['browser'] } : undefined,
    test: {
      environment: 'node',
      include: ['src/**/*.test.ts'],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'html', 'lcov'],
        include: ['src/**/*.{ts,svelte}'],
        exclude: ['src/**/*.d.ts', 'src/**/*.test.ts', 'src/app.d.ts', 'src/generated/**'],
      },
    },
  })
);
