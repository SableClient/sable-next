// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { expect, test } from 'vitest';

import PresenceDot from './PresenceDot.svelte';

test('exposes the presence as an accessible name, not just colour', () => {
  render(PresenceDot, { presence: 'online', label: 'Online' });

  expect(screen.getByRole('img', { name: 'Online' })).toHaveAttribute('data-presence', 'online');
});

test('applies the caller class alongside its own', () => {
  render(PresenceDot, { presence: 'unavailable', label: 'Away', class: 'custom' });

  expect(screen.getByRole('img', { name: 'Away' })).toHaveClass('presence-dot', 'custom');
});

test.each([
  ['online', 'circle', 'path'],
  ['unavailable', 'path', 'circle'],
  ['offline', 'circle[fill="none"]', 'path'],
] as const)('draws %s with its own shape', (presence, shown, hidden) => {
  render(PresenceDot, { presence, label: presence });

  const dot = screen.getByRole('img', { name: presence });
  expect(dot.querySelector(shown)).not.toBeNull();
  expect(dot.querySelector(hidden)).toBeNull();
});
