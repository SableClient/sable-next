// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';

import { LOGGED_IN_MARKER } from '#lib/features/auth/flow/auth-flow.svelte.js';
import HomeLanding from './HomeLanding.svelte';
import SettingsChangesCard from './SettingsChangesCard.svelte';

vi.mock('#lib/core/context.js');

afterEach(() => {
  localStorage.removeItem(LOGGED_IN_MARKER);
  localStorage.clear();
});

test('opens Get support in the Sable general room', () => {
  render(HomeLanding, { titleKey: 'nav.unspaced' });

  expect(screen.getByRole('link', { name: 'Get support' })).toHaveAttribute(
    'href',
    '/to/%23general%3Asable.moe'
  );
  expect(screen.getByRole('link', { name: 'Get support' })).not.toHaveAttribute('target');
});

test('welcomes a returning user back', () => {
  localStorage.setItem(LOGGED_IN_MARKER, 'true');
  render(HomeLanding, { titleKey: 'nav.unspaced' });

  expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Welcome back');
});

const changes = {
  upcoming: {
    added: ['showAllTimestamps', 'launchAtLogin'],
    changed: [{ key: 'twitterEmoji' }],
  },
};

test('links new and changed settings and skips unsupported ones', () => {
  render(SettingsChangesCard, { changes, version: '' });

  expect(screen.getByRole('link', { name: 'Show the time on every message' })).toHaveAttribute(
    'href',
    '/settings/timeline?focus=show-all-timestamps'
  );
  expect(screen.getByRole('link', { name: 'Twitter emoji' })).toHaveAttribute(
    'href',
    '/settings/emotes?focus=twitter-emoji'
  );
  expect(screen.getByText('New')).toBeInTheDocument();
  expect(screen.getByText('Default changed')).toBeInTheDocument();
  expect(screen.queryByRole('link', { name: /login/i })).not.toBeInTheDocument();
});

test('stays hidden when the running release has no changes', () => {
  render(SettingsChangesCard, { changes, version: '1.0.0' });

  expect(screen.queryByText('New and changed settings')).not.toBeInTheDocument();
});

test('stays dismissed across renders', async () => {
  const { unmount } = render(SettingsChangesCard, { changes, version: '' });
  await fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }));
  expect(screen.queryByText('New and changed settings')).not.toBeInTheDocument();
  unmount();

  render(SettingsChangesCard, { changes, version: '' });
  expect(screen.queryByText('New and changed settings')).not.toBeInTheDocument();
});
