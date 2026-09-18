// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/i18n.js', () => ({
  i18n: {
    subscribe(run: (value: { t: (key: string) => string }) => void) {
      run({ t: (key) => key });
      return () => {};
    },
  },
}));

import ScheduleComposer from './ScheduleComposer.svelte';

afterEach(() => {
  document.body.replaceChildren();
});

function input(type: string): HTMLInputElement {
  const element = document.querySelector(`input[type="${type}"]`);
  if (!(element instanceof HTMLInputElement)) throw new Error(`${type} input not found`);
  return element;
}

test('picking a date moves focus to the time, which closes the native picker', async () => {
  const instance = mount(ScheduleComposer, {
    target: document.body,
    props: { open: true, empty: false, onSchedule: vi.fn() },
  });
  await tick();

  const date = input('date');
  date.focus();
  date.value = '2026-09-20';
  date.dispatchEvent(new Event('change', { bubbles: true }));
  await tick();

  expect(document.activeElement).toBe(input('time'));

  void unmount(instance);
});
