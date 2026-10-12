import '@testing-library/jest-dom/vitest';
import '@testing-library/svelte/vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, afterEach } from 'vitest';

import { initSync } from '#src/generated/wasm/sable_model.js';

import { resetNavigation } from '#lib/test-support/app-navigation.js';
import { resetPage } from '#lib/test-support/app-state.js';

initSync({ module: readFileSync(join(process.cwd(), 'src/generated/wasm/sable_model_bg.wasm')) });

afterEach(() => {
  if (typeof document !== 'undefined') document.body.removeAttribute('style');
  resetPage();
  resetNavigation();
});

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 32));
});
