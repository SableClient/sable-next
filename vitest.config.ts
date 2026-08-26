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
      projects: [
        {
          extends: true,
          test: {
            name: 'node',
            environment: 'node',
            include: ['src/**/*.test.ts'],
            exclude: [
              'src/lib/features/room/TimelineReadReceipt.svelte.test.ts',
              'src/lib/features/room/message-swipe.svelte.test.ts',
            ],
          },
        },
        {
          extends: true,
          test: {
            name: 'happy-dom',
            environment: 'happy-dom',
            include: [
              'src/lib/features/room/TimelineReadReceipt.svelte.test.ts',
              'src/lib/features/room/message-swipe.svelte.test.ts',
            ],
          },
        },
      ],
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
