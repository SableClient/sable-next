import { defineConfig, devices } from '@playwright/test';

const port = process.env.SABLE_PREVIEW_PORT ?? '4173';
const origin = `http://127.0.0.1:${port}`;

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  // One preview server and one homeserver back the whole suite, so uncapped
  // workers starve each other into timeouts.
  workers: 4,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  timeout: 60_000,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    baseURL: origin,
    trace: 'on-first-retry',
    // A click must not land mid-transition.
    contextOptions: { reducedMotion: 'reduce' },
  },
  projects: [
    {
      name: 'setup',
      testMatch: /global\.setup\.ts/,
      teardown: 'teardown',
      retries: 0,
    },
    { name: 'teardown', testMatch: /global\.teardown\.ts/ },
    {
      name: 'chromium',
      dependencies: ['setup'],
      testIgnore: /global\.(setup|teardown)\.ts/,
      use: devices['Desktop Chrome'],
    },
    {
      // Sable ships an iOS app, whose Tauri webview is WebKit. Keep this
      // deliberately small so it catches compatibility regressions cheaply.
      name: 'webkit',
      dependencies: ['setup'],
      testMatch: /(?:^|\/)(?:app-shell|login|navigation)\.spec\.ts$/,
      use: devices['Desktop Safari'],
    },
  ],
  webServer: {
    command: `SABLE_WASM_OUTPUT=src/generated/wasm-e2e pnpm run build && pnpm exec vite preview --host 127.0.0.1 --port ${port} --strictPort`,
    url: origin,
    reuseExistingServer: !process.env.CI,
    timeout: 600_000,
    gracefulShutdown: {
      signal: 'SIGTERM',
      timeout: 5_000,
    },
  },
});
