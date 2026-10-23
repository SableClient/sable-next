import { defineConfig, devices } from '@playwright/test';

const origin = 'http://127.0.0.1:4187';

export default defineConfig({
  testDir: '.',
  testMatch: 'runtime-tabs.spec.ts',
  timeout: 60_000,
  use: { baseURL: origin },
  projects: [{ name: 'chromium', use: devices['Desktop Chrome'] }],
  webServer: {
    cwd: '../..',
    command:
      'SABLE_WASM_OUTPUT=src/generated/wasm-runtime SABLE_WASM_FEATURES=sable-wasm/demo node scripts/build/build-wasm.mjs && SABLE_WASM_OUTPUT=src/generated/wasm-runtime SABLE_SKIP_DEEPFILTERNET=1 pnpm exec vite dev --host 127.0.0.1 --port 4187 --strictPort',
    url: origin,
    reuseExistingServer: false,
    timeout: 900_000,
  },
});
