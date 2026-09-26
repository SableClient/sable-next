// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/i18n.js', () => ({
  i18n: {
    subscribe(run: (value: { t: (key: string) => string }) => void) {
      run({ t: (key) => key });
      return () => {};
    },
  },
  currentLocale: () => 'en',
}));

import { preferences, setPreference } from '#lib/settings/preferences.svelte.js';

import ScheduleComposer from './ScheduleComposer.svelte';

afterEach(() => {
  setPreference('scheduleInEncryptedRooms', true);
  preferences.dateFormat = 'auto';
  preferences.hour24Clock = false;
});

function segments(): string {
  return [...document.querySelectorAll('[data-segment]')]
    .map((segment) => segment.textContent)
    .join('')
    .trim();
}

test('a scheduled message being edited opens on its own time and can be saved as is', async () => {
  preferences.dateFormat = 'dmy';
  preferences.hour24Clock = true;
  const dueTs = new Date('2099-09-20T14:30:00').getTime();
  const user = userEvent.setup();
  const onSchedule = vi.fn();
  render(ScheduleComposer, { open: true, empty: false, dueTs, onSchedule });

  const confirm = await screen.findByRole('button', { name: 'composer.scheduleConfirm' });
  expect(segments()).toBe('20/09/2099, 14:30');
  expect(confirm).toBeEnabled();
  await user.click(confirm);

  expect(onSchedule).toHaveBeenCalledWith(dueTs);
});

const presetButton = () => screen.findByRole('button', { name: 'composer.scheduleIn30Minutes' });

test('an encrypted room with the preference off cannot be scheduled into', async () => {
  setPreference('scheduleInEncryptedRooms', false);
  render(ScheduleComposer, { open: true, empty: false, encrypted: true, onSchedule: vi.fn() });

  expect(await presetButton()).toBeDisabled();
  expect(screen.getByText('composer.scheduleEncryptedBlocked')).toBeInTheDocument();
});

test('an encrypted room says where the message waits while the preference allows it', async () => {
  render(ScheduleComposer, { open: true, empty: false, encrypted: true, onSchedule: vi.fn() });

  expect(await presetButton()).toBeEnabled();
  expect(screen.getByText('composer.scheduleEncryptedNote')).toBeInTheDocument();
});
