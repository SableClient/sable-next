// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';

import CoreHealthBanner from './CoreHealthBanner.svelte';

const offer = Object.assign(core, {
  crashed: null,
  superseded: false,
  storageInterrupted: false,
  unresponsive: false,
  localNetworkBlocked: null,
  sync: { state: 'offline' },
  localNetworkOffer: 'matrix.home.example',
  allowLocalNetwork: vi.fn(() => Promise.resolve()),
  declineLocalNetwork: vi.fn(),
  retrySync: vi.fn(() => Promise.resolve()),
});

beforeEach(() => {
  vi.useFakeTimers({ shouldAdvanceTime: true });
});

afterEach(() => {
  vi.useRealTimers();
  Object.assign(offer, { localNetworkOffer: 'matrix.home.example' });
  vi.clearAllMocks();
});

test('local network access is offered with its reason once the app stays offline', async () => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(CoreHealthBanner);
  expect(screen.queryByRole('alert')).toBeNull();

  await vi.advanceTimersByTimeAsync(3000);
  expect(screen.getByRole('alert')).toHaveTextContent('matrix.home.example');

  await user.click(screen.getByRole('button', { name: 'Continue' }));
  expect(offer.allowLocalNetwork).toHaveBeenCalledOnce();
});

test('the offer can be turned down', async () => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  render(CoreHealthBanner);
  await vi.advanceTimersByTimeAsync(3000);

  await user.click(screen.getByRole('button', { name: 'Not now' }));
  expect(offer.declineLocalNetwork).toHaveBeenCalledOnce();
});

test('without an offer the banner says the app is offline and can retry', async () => {
  const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime });
  Object.assign(offer, { localNetworkOffer: null });
  render(CoreHealthBanner);
  await vi.advanceTimersByTimeAsync(3000);

  expect(screen.getByRole('alert')).toHaveTextContent('You are offline');
  expect(screen.queryByRole('button', { name: 'Continue' })).toBeNull();

  await user.click(screen.getByRole('button', { name: 'Retry' }));
  expect(offer.retrySync).toHaveBeenCalledOnce();
});
