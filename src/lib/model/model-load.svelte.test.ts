import { afterEach, expect, test, vi } from 'vitest';

const loadModel = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
vi.mock('./model.js', () => ({ loadModel }));

import { loadModelForApp, modelLoadFailed } from './model-load.svelte.js';

afterEach(() => {
  loadModel.mockReset();
});

test('a failed load is surfaced and a later success clears it', async () => {
  loadModel.mockRejectedValueOnce(new Error('Load failed')).mockResolvedValueOnce({});

  await expect(loadModelForApp()).rejects.toThrow('Load failed');
  expect(modelLoadFailed()).toBe(true);

  await loadModelForApp();
  expect(modelLoadFailed()).toBe(false);
});
