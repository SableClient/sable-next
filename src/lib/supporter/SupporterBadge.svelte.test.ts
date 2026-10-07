// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { expect, test } from 'vitest';

import SupporterBadge from './SupporterBadge.svelte';

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
