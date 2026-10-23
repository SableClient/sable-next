import { playwright } from '@vitest/browser-playwright';
import { mergeConfig } from 'vite';
import { defineConfig, defineProject } from 'vitest/config';

import viteConfig from './vite.config.ts';

const COVERAGE_MINIMUM = 46;

const HAPPY_DOM_TESTS = [
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
  'src/lib/platform/devtools.test.ts',
  'src/lib/platform/keyboard.test.ts',
  'src/lib/settings/theme-styles.test.ts',
  'src/lib/features/room/messages/reply-preview.test.ts',
  'src/lib/ui/primitives/Switcher.svelte.test.ts',
];

export default mergeConfig(
  viteConfig,
  defineConfig({
    resolve: process.env.VITEST ? { conditions: ['browser'] } : undefined,
    test: {
      maxWorkers: 4,
      setupFiles: ['./tests/vitest-setup.ts'],
      // Async mode schedules updates on animation frames, which would never fire if faked.
      fakeTimers: {
        toFake: [
          'setTimeout',
          'clearTimeout',
          'setInterval',
          'clearInterval',
          'setImmediate',
          'clearImmediate',
          'Date',
          'performance',
          'requestIdleCallback',
          'cancelIdleCallback',
        ],
      },
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
          test: {
            name: 'node',
            environment: 'node',
            include: [
              'src/**/*.test.ts',
              'electron/src/**/*.test.ts',
              'tests/e2e/fixtures/*.test.ts',
            ],
            exclude: ['**/*.browser.test.ts', ...HAPPY_DOM_TESTS],
          },
        },
        {
          test: {
            name: 'happy-dom',
            environment: 'happy-dom',
            include: HAPPY_DOM_TESTS,
          },
        },
        {
          ...mergeConfig(
            viteConfig,
            defineProject({
              test: {
                name: 'browser',
                include: ['src/**/*.browser.test.ts', 'tests/e2e/fixtures/*.browser.test.ts'],
                setupFiles: ['./tests/vitest-browser-setup.ts'],
                expect: { poll: { timeout: 5000 } },
                browser: {
                  enabled: true,
                  headless: true,
                  provider: playwright({ contextOptions: { reducedMotion: 'reduce' } }),
                  instances: [{ browser: 'chromium' }],
                  commands: {
                    emulateColorScheme: async (context, scheme: 'light' | 'dark') => {
                      await context.page.emulateMedia({ colorScheme: scheme });
                    },
                  },
                },
              },
            })
          ),
          extends: false,
        },
      ],
      coverage: {
        provider: 'v8',
        reporter: ['text', 'html', 'lcov'],
        include: ['src/**/*.{ts,svelte}'],
        exclude: [
          'src/**/*.d.ts',
          'src/**/__mocks__/**',
          'src/lib/test-support/**',
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
