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

import { setPreference } from '#lib/settings/preferences.svelte.js';

import ScheduleComposer from './ScheduleComposer.svelte';

afterEach(() => {
  document.body.replaceChildren();
  setPreference('scheduleInEncryptedRooms', true);
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

test('a scheduled message being edited opens on its own time and can be saved as is', async () => {
  const dueTs = new Date('2099-09-20T14:30:00').getTime();
  const onSchedule = vi.fn();
  const instance = mount(ScheduleComposer, {
    target: document.body,
    props: { open: true, empty: false, dueTs, onSchedule },
  });
  await tick();

  expect(input('date').value).toBe('2099-09-20');
  expect(input('time').value).toBe('14:30');

  const confirm = document.querySelector('button[type="submit"]');
  if (!(confirm instanceof HTMLButtonElement)) throw new Error('confirm button not found');
  expect(confirm.disabled).toBe(false);
  confirm.click();
  await tick();

  expect(onSchedule).toHaveBeenCalledWith(dueTs);

  void unmount(instance);
});

function presetButton(): HTMLButtonElement {
  const element = document.querySelector('.presets button');
  if (!(element instanceof HTMLButtonElement)) throw new Error('preset button not found');
  return element;
}

test('an encrypted room with the preference off cannot be scheduled into', async () => {
  setPreference('scheduleInEncryptedRooms', false);
  const instance = mount(ScheduleComposer, {
    target: document.body,
    props: { open: true, empty: false, encrypted: true, onSchedule: vi.fn() },
  });
  await tick();

  expect(document.body.textContent).toContain('composer.scheduleEncryptedBlocked');
  expect(presetButton().disabled).toBe(true);

  void unmount(instance);
});

test('an encrypted room says where the message waits while the preference allows it', async () => {
  const instance = mount(ScheduleComposer, {
    target: document.body,
    props: { open: true, empty: false, encrypted: true, onSchedule: vi.fn() },
  });
  await tick();

  expect(document.body.textContent).toContain('composer.scheduleEncryptedNote');
  expect(presetButton().disabled).toBe(false);

  void unmount(instance);
});
