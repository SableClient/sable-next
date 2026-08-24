import { mergeConfig } from 'vite';
import { defineConfig } from 'vitest/config';

import viteConfig from './vite.config.ts';

export default mergeConfig(
  viteConfig,
  defineConfig({
    resolve: process.env.VITEST ? { conditions: ['browser'] } : undefined,
    test: {
      alias: {
        '$app/paths/internal/client': new URL(
          './node_modules/@sveltejs/kit/src/runtime/app/paths/internal/client.js',
          import.meta.url
        ).pathname,
        '$app/paths': new URL(
          './node_modules/@sveltejs/kit/src/runtime/app/paths/client.js',
          import.meta.url
        ).pathname,
      },
      environment: 'node',
      include: ['src/**/*.test.ts'],
      setupFiles: ['./vitest-setup.ts'],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'html', 'lcov'],
        include: ['src/**/*.{ts,svelte}'],
        exclude: ['src/**/*.d.ts', 'src/**/*.test.ts', 'src/app.d.ts', 'src/generated/**'],
      },
    },
  })
);
