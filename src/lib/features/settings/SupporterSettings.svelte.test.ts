// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

import { supporter } from '#lib/supporter/supporter.svelte.js';

import SupporterSettings from './SupporterSettings.svelte';
import SupporterActivationSettings from './SupporterActivationSettings.svelte';

vi.mock('#lib/core/context.js');

afterEach(() => {
  supporter.badge = null;
  supporter.status = 'idle';
  vi.restoreAllMocks();
});

test('offers to verify with Open Collective', async () => {
  const verify = vi.spyOn(supporter, 'verify').mockResolvedValue();
  render(SupporterActivationSettings);

  await userEvent.click(screen.getByRole('button', { name: 'Verify with Open Collective' }));

  expect(verify).toHaveBeenCalledOnce();
});

test('lets someone fetch a badge that was issued by hand', async () => {
  const claim = vi.spyOn(supporter, 'claim').mockResolvedValue();
  render(SupporterActivationSettings);

  await userEvent.click(screen.getByRole('button', { name: 'Check' }));

  expect(claim).toHaveBeenCalledOnce();
});

test('shows progress and a cancel button while waiting', async () => {
  supporter.status = 'waiting';
  const cancel = vi.spyOn(supporter, 'cancel').mockImplementation(() => {});
  render(SupporterActivationSettings);

  expect(screen.getByText(/Waiting for you to approve/)).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

  expect(cancel).toHaveBeenCalledOnce();
});

test('shows the active badge and lets it be removed', async () => {
  supporter.badge = { label: 'Donor', tier: null, expiresAt: 4102444800 };
  const remove = vi.spyOn(supporter, 'remove').mockResolvedValue();
  render(SupporterSettings);

  expect(screen.getByText('Supporter badge active')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: /^Donor ·/ })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: 'Remove' }));

  expect(remove).toHaveBeenCalledOnce();
});
