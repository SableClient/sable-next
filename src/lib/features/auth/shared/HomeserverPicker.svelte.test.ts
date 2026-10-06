// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import HomeserverPicker from './HomeserverPicker.svelte';
import { homeservers } from './homeservers.svelte.js';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

function setupUser() {
  return userEvent.setup({ advanceTimers: (ms) => vi.advanceTimersByTime(ms) });
}

test('settles once typing pauses, without waiting for a blur', async () => {
  const user = setupUser();
  const onsettle = vi.fn();
  render(HomeserverPicker, { id: 'homeserver', onsettle });
  const input = screen.getByRole('combobox');

  await user.type(input, 'kubes.c');
  vi.advanceTimersByTime(300);
  await user.type(input, 'loud');
  vi.advanceTimersByTime(599);
  expect(onsettle).not.toHaveBeenCalled();

  vi.advanceTimersByTime(1);
  expect(onsettle).toHaveBeenCalledOnce();
});

test('a blur or a blank field cancels the pending settle', async () => {
  const user = setupUser();
  const onsettle = vi.fn();
  const onblur = vi.fn();
  render(HomeserverPicker, { id: 'homeserver', onsettle, onblur });
  const input = screen.getByRole('combobox');

  await user.type(input, 'kubes.cloud');
  await user.tab();
  await user.clear(input);
  await user.type(input, '  ');
  vi.advanceTimersByTime(1000);

  expect(onblur).toHaveBeenCalledOnce();
  expect(onsettle).not.toHaveBeenCalled();
});

test('server names are never capitalised in the fixed list', () => {
  expect(homeservers.items.length).toBeGreaterThan(0);
  expect(homeservers.items.every((item) => item.labelClass === 'literal-label')).toBe(true);
});
