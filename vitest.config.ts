import { mergeConfig } from 'vite';
import { defineConfig } from 'vitest/config';

import viteConfig from './vite.config.ts';

const COVERAGE_MINIMUM = 46;

export default mergeConfig(
  viteConfig,
  defineConfig({
    resolve: process.env.VITEST ? { conditions: ['browser'] } : undefined,
    test: {
      maxWorkers: 4,
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
              'src/lib/features/composer/VoiceRecorder.svelte.test.ts',
              'src/lib/features/composer/voice-recorder-encoder.test.ts',
              'src/lib/features/room/timeline/TimelineReadReceipt.svelte.test.ts',
              'src/lib/ui/long-press.svelte.test.ts',
              'src/lib/ui/scroll-hint.svelte.test.ts',
              'src/lib/features/room/messages/message-swipe.svelte.test.ts',
              'src/lib/core/attachment-info.test.ts',
              'src/lib/ui/shortcuts/binding.test.ts',
              'src/lib/ui/shortcuts/global-shortcuts.test.ts',
              'src/lib/ui/swipe-gesture.test.ts',
              'src/lib/ui/swipe-back.svelte.test.ts',
              'src/lib/ui/double-tap.test.ts',
              'src/lib/ui/trailing-click.test.ts',
              'src/lib/ui/video-support.test.ts',
              'src/lib/platform/devtools.test.ts',
              'src/lib/platform/keyboard.test.ts',
              'src/lib/settings/theme-styles.test.ts',
              'src/lib/features/room/messages/reply-preview.test.ts',
              'src/lib/ui/primitives/Switcher.svelte.test.ts',
            ],
          },
        },
        {
          extends: true,
          test: {
            name: 'happy-dom',
            environment: 'happy-dom',
            include: [
              'src/lib/features/composer/VoiceRecorder.svelte.test.ts',
              'src/lib/features/composer/voice-recorder-encoder.test.ts',
              'src/lib/features/room/timeline/TimelineReadReceipt.svelte.test.ts',
              'src/lib/ui/long-press.svelte.test.ts',
              'src/lib/ui/scroll-hint.svelte.test.ts',
              'src/lib/features/room/messages/message-swipe.svelte.test.ts',
              'src/lib/core/attachment-info.test.ts',
              'src/lib/ui/shortcuts/binding.test.ts',
              'src/lib/ui/shortcuts/global-shortcuts.test.ts',
              'src/lib/ui/swipe-gesture.test.ts',
              'src/lib/ui/swipe-back.svelte.test.ts',
              'src/lib/ui/double-tap.test.ts',
              'src/lib/ui/trailing-click.test.ts',
              'src/lib/ui/video-support.test.ts',
              'src/lib/platform/devtools.test.ts',
              'src/lib/platform/keyboard.test.ts',
              'src/lib/settings/theme-styles.test.ts',
              'src/lib/features/room/messages/reply-preview.test.ts',
              'src/lib/ui/primitives/Switcher.svelte.test.ts',
            ],
          },
        },
      ],
      setupFiles: ['./vitest-setup.ts'],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'html', 'lcov'],
        include: ['src/**/*.{ts,svelte}'],
        exclude: [
          'src/**/*.d.ts',
          'src/**/*.test.ts',
          'src/**/__mocks__/**',
          'src/lib/test-support/**',
          'src/app.d.ts',
          'src/generated/**',
        ],
        thresholds: {
          lines: COVERAGE_MINIMUM,
          functions: COVERAGE_MINIMUM,
          branches: COVERAGE_MINIMUM,
          statements: COVERAGE_MINIMUM,
        },
      },
    },
  })
);
