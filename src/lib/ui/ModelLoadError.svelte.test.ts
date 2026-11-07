// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

const loadModel = vi.hoisted(() => vi.fn<() => Promise<unknown>>());
vi.mock('#lib/model/model.js', () => ({ loadModel }));

import { loadModelForApp, modelLoadFailed } from '#lib/model/model-load.svelte.js';

import ModelLoadError from './ModelLoadError.svelte';

afterEach(() => {
  loadModel.mockReset();
  vi.restoreAllMocks();
});

test('trying again loads the model and clears the failure', async () => {
  loadModel.mockRejectedValueOnce(new Error('Load failed')).mockResolvedValueOnce({});
  await expect(loadModelForApp()).rejects.toThrow('Load failed');
  render(ModelLoadError);

  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

  await vi.waitFor(() => {
    expect(modelLoadFailed()).toBe(false);
  });
});

test('a retry that fails again keeps the failure and the button', async () => {
  vi.spyOn(console, 'warn').mockImplementation(() => {});
  loadModel.mockRejectedValue(new Error('Load failed'));
  await expect(loadModelForApp()).rejects.toThrow('Load failed');
  render(ModelLoadError);

  await userEvent.click(screen.getByRole('button', { name: 'Try again' }));

  await vi.waitFor(() => {
    expect(screen.getByRole('button', { name: 'Try again' })).toBeEnabled();
  });
  expect(modelLoadFailed()).toBe(true);
});
