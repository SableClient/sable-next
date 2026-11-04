// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';
import { isTauri } from '@tauri-apps/api/core';

import SupporterBadge from './SupporterBadge.svelte';

vi.mock('@tauri-apps/api/core', () => ({ isTauri: vi.fn(() => false) }));
vi.mock('@tauri-apps/plugin-os', () => ({ type: () => 'ios' }));

afterEach(() => {
  vi.mocked(isTauri).mockReturnValue(false);
});

async function openCard() {
  const user = userEvent.setup();
  render(SupporterBadge, { label: 'Donor' });
  await user.click(screen.getByRole('button', { name: /Donor/ }));
  await screen.findByRole('dialog');
  return user;
}

test('closes the card once the donate link is followed', async () => {
  const user = await openCard();
  const donate = screen.getByRole('link');
  donate.addEventListener('click', (event) => {
    event.preventDefault();
  });

  await user.click(donate);

  expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
});

test('closes the card when the window loses focus', async () => {
  await openCard();

  window.dispatchEvent(new Event('blur'));

  await expect.poll(() => screen.queryByRole('dialog')).toBeNull();
});

test('iOS keeps the badge without donation links or prompts', async () => {
  vi.mocked(isTauri).mockReturnValue(true);
  await openCard();

  expect(screen.getByRole('heading', { name: 'Donor' })).toBeInTheDocument();
  expect(screen.queryByRole('link')).not.toBeInTheDocument();
  expect(screen.queryByText(/you can too/)).not.toBeInTheDocument();
  expect(screen.queryByText(/Any amount earns a badge/)).not.toBeInTheDocument();
  expect(screen.getByRole('dialog')).not.toHaveAttribute('aria-describedby');
});
