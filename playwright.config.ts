import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 2 : 0,
  reporter: process.env.CI ? [['html', { open: 'never' }], ['list']] : 'list',
  use: {
    baseURL: 'http://127.0.0.1:4173',
    trace: 'on-first-retry',
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
  ],
  webServer: {
    command: 'pnpm run build && pnpm exec vite preview --host 127.0.0.1 --port 4173 --strictPort',
    url: 'http://127.0.0.1:4173',
    reuseExistingServer: !process.env.CI,
    timeout: 300_000,
    gracefulShutdown: {
      signal: 'SIGTERM',
      timeout: 5_000,
    },
  },
});
