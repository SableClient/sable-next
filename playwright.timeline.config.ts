import { defineConfig, devices } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  testMatch: process.env.SABLE_E2E_MATCH ?? 'timeline-stability.spec.ts',
  workers: 1,
  timeout: 60_000,
  use: { baseURL: 'http://127.0.0.1:4175', contextOptions: { reducedMotion: 'reduce' } },
  projects: [
    { name: 'chromium', use: devices['Desktop Chrome'] },
    { name: 'webkit', use: devices['Desktop Safari'] },
  ],
  webServer: {
    command: 'pnpm exec vite dev --host 127.0.0.1 --port 4175 --strictPort',
    url: 'http://127.0.0.1:4175',
    reuseExistingServer: !process.env.CI,
    timeout: 120_000,
  },
});
