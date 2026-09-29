// @vitest-environment happy-dom

import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import TooltipTeardownHarness from './TooltipTeardownHarness.test.svelte';

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

test('a tooltip removed before delayed listener setup does not revive its destroyed state', async () => {
  vi.useFakeTimers();
  const warn = vi.spyOn(console, 'warn');
  const addListener = vi.spyOn(document, 'addEventListener');
  const view = render(TooltipTeardownHarness);
  await tick();

  view.unmount();
  await tick();
  addListener.mockClear();
  await vi.advanceTimersByTimeAsync(10);

  expect(warn.mock.calls.flat().join(' ')).not.toContain('derived_inert');
  expect(addListener).not.toHaveBeenCalled();
});
