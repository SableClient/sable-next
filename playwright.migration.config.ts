import { defineConfig } from '@playwright/test';
import base from './playwright.timeline.config.js';

export default defineConfig({
  ...base,
  testMatch: 'v1-migration.spec.ts',
  use: { ...base.use, baseURL: 'http://127.0.0.1:4186' },
  webServer: {
    command: 'pnpm exec vite dev --host 127.0.0.1 --port 4186 --strictPort',
    url: 'http://127.0.0.1:4186',
    reuseExistingServer: false,
  },
  projects: base.projects?.map(({ grep: _grep, grepInvert: _grepInvert, ...project }) => project),
});
