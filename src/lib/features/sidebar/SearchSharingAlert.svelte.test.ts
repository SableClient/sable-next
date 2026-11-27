// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import type { CoreEvent, SearchSharingView } from '#src/generated/protocol';

vi.mock('$app/state', () => import('#lib/test-support/app-state.js'));
vi.mock('$app/navigation', () => import('#lib/test-support/app-navigation.js'));
vi.mock('#lib/core/context.js');
const platform = vi.hoisted(() => ({ nativeMobile: true }));
vi.mock('#lib/platform/os.js', async (original) => ({
  ...(await original<typeof import('#lib/platform/os.js')>()),
  isNativeMobile: () => platform.nativeMobile,
}));

import { core } from '#lib/core/__mocks__/context.js';
import { goto } from '$app/navigation';
import Harness from './SearchSharingAlertHarness.test.svelte';

const failed: SearchSharingView = {
  state: 'idle',
  pause: null,
  outcome: 'failed',
  peer: null,
  transferred_rooms: 0,
  total_rooms: 0,
  last_copy: null,
  automatic: false,
  asked: 1,
  candidates: [
    { device_id: 'PEER', name: null, documents: 10, complete_rooms: 1, status: 'failed' },
  ],
};

afterEach(() => {
  platform.nativeMobile = true;
});

function emit(event: CoreEvent): void {
  const [listener] = core.subscribeEvents.mock.lastCall as unknown as [(event: CoreEvent) => void];
  listener(event);
}

test('a failed transfer paused on a metered network says why and offers the setting', async () => {
  render(Harness);
  emit({ type: 'search_sharing', sharing: { ...failed, pause: 'metered' } });

  expect(
    await screen.findByText(
      'Paused on cellular or Low Data Mode. Turn off the unmetered network setting to copy anyway.'
    )
  ).toBeInTheDocument();
  await userEvent.setup().click(screen.getByRole('button', { name: 'Settings' }));
  expect(goto).toHaveBeenCalledWith(
    expect.stringContaining('settings/search?focus=search-unmetered-only'),
    expect.anything()
  );
});

test('a failed transfer on an allowed network keeps the generic failure', async () => {
  render(Harness);
  emit({ type: 'search_sharing', sharing: failed });

  expect(await screen.findByText('An error occurred during the transfer.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument();
});

test('a failed transfer paused while offline says so instead of offering a retry that cannot start', async () => {
  render(Harness);
  emit({ type: 'search_sharing', sharing: { ...failed, pause: 'offline' } });

  expect(await screen.findByText('Paused while offline.')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
});

test('a metered pause off mobile explains itself without a setting or a retry', async () => {
  platform.nativeMobile = false;
  render(Harness);
  emit({ type: 'search_sharing', sharing: { ...failed, pause: 'metered' } });

  expect(
    await screen.findByText('Paused on a cellular or data saver connection.')
  ).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Settings' })).not.toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Retry' })).not.toBeInTheDocument();
});
