import '@testing-library/jest-dom/vitest';
import '@testing-library/svelte/vitest';
import { afterAll, afterEach } from 'vitest';

import { resetNavigation } from '#lib/test-support/app-navigation.js';
import { resetPage } from '#lib/test-support/app-state.js';

afterEach(() => {
  if (typeof document !== 'undefined') document.body.removeAttribute('style');
  resetPage();
  resetNavigation();
});

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 32));
});
