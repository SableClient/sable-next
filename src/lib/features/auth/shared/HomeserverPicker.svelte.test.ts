// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import HomeserverPicker from './HomeserverPicker.svelte';

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  document.body.replaceChildren();
});

function type(value: string): HTMLInputElement {
  const input = document.querySelector<HTMLInputElement>('#homeserver');
  if (!input) throw new Error('missing input');
  input.value = value;
  input.dispatchEvent(new Event('input', { bubbles: true }));
  return input;
}

test('settles once typing pauses, without waiting for a blur', async () => {
  const onsettle = vi.fn();
  const instance = mount(HomeserverPicker, {
    target: document.body,
    props: { id: 'homeserver', onsettle },
  });
  await tick();

  type('kubes.c');
  vi.advanceTimersByTime(300);
  type('kubes.cloud');
  vi.advanceTimersByTime(599);
  expect(onsettle).not.toHaveBeenCalled();

  vi.advanceTimersByTime(1);
  expect(onsettle).toHaveBeenCalledOnce();

  await unmount(instance);
});

test('a blur or a blank field cancels the pending settle', async () => {
  const onsettle = vi.fn();
  const onblur = vi.fn();
  const instance = mount(HomeserverPicker, {
    target: document.body,
    props: { id: 'homeserver', onsettle, onblur },
  });
  await tick();

  type('kubes.cloud').dispatchEvent(new FocusEvent('blur'));
  type('  ');
  vi.advanceTimersByTime(1000);

  expect(onblur).toHaveBeenCalledOnce();
  expect(onsettle).not.toHaveBeenCalled();

  await unmount(instance);
});
