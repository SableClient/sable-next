import { afterAll } from 'vitest';

afterAll(async () => {
  await new Promise((resolve) => setTimeout(resolve, 32));
});
