// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import ChatCircleDotsIcon from 'phosphor-svelte/lib/ChatCircleDotsIcon';
import { expect, test, vi } from 'vitest';

import ActionCard from './ActionCard.svelte';
import SableBrandMark from './SableBrandMark.svelte';

test('action cards use links for navigation', () => {
  render(ActionCard, {
    icon: ChatCircleDotsIcon,
    title: 'Explore',
    description: 'Browse public rooms.',
    href: '/explore',
  });

  const card = screen.getByRole('link', { name: /Explore/ });
  expect(card).toHaveAttribute('href', '/explore');
  expect(card).toHaveTextContent('Browse public rooms.');
});

test('action cards use buttons for in-app actions', async () => {
  const user = userEvent.setup();
  const onclick = vi.fn();
  render(ActionCard, { icon: ChatCircleDotsIcon, title: 'Join a room', onclick });

  const card = screen.getByRole('button', { name: 'Join a room' });
  expect(card).toBeEnabled();
  await user.click(card);

  expect(onclick).toHaveBeenCalledOnce();
});

test('inactive action cards are disabled semantically', () => {
  render(ActionCard, { icon: ChatCircleDotsIcon, title: 'Join a room', disabled: true });

  expect(screen.getByRole('button', { name: 'Join a room' })).toBeDisabled();
});

test('the Sable brand mark stays decorative', () => {
  const { container } = render(SableBrandMark);

  expect(screen.queryByRole('img')).not.toBeInTheDocument();
  expect(container.querySelector('img')).toHaveClass('brand-mark');
});
