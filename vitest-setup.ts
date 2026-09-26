import '@testing-library/jest-dom/vitest';
import '@testing-library/svelte/vitest';
import { afterAll, afterEach } from 'vitest';

afterEach(() => {
  if (typeof document !== 'undefined') document.body.removeAttribute('style');
});

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 32));
});
