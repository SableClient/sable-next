// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import { core as baseCore } from '#lib/core/__mocks__/context.js';

type Mode = 'off' | 'notify' | 'loud';

const core = Object.assign(baseCore, {
  session: { user_id: '@erwan:example.org' },
  userProfile: vi.fn(() => Promise.resolve({ display_name: 'Erwan' })),
  mentionNotifications: vi.fn<() => Promise<Record<string, Mode | null>>>(),
  setMentionNotifications: vi.fn<(rule: string, mode: Mode) => Promise<void>>(),
});

import MentionNotifications from './MentionNotifications.svelte';

afterEach(() => {
  vi.clearAllMocks();
});

const loaded = { room: 'notify', user: 'loud', display_name: 'off', username: 'loud' } as const;

const selector = (label: string): HTMLElement => screen.getByLabelText(label);

test('shows every mention rule at its account mode', async () => {
  core.mentionNotifications.mockResolvedValue(loaded);

  render(MentionNotifications);

  await vi.waitFor(() => {
    expect(selector('User ID (@erwan:example.org)')).toHaveTextContent('Loud');
  });
  expect(selector('Display name (Erwan)')).toHaveTextContent('Off');
  expect(selector('Username (erwan)')).toHaveTextContent('Loud');
  expect(selector('@room')).toHaveTextContent('Notify');
});

test('hides the legacy rules a server has removed', async () => {
  core.mentionNotifications.mockResolvedValue({ ...loaded, display_name: null, username: null });

  render(MentionNotifications);

  await vi.waitFor(() => {
    expect(selector('@room')).toHaveTextContent('Notify');
  });
  expect(screen.queryByLabelText(/^Display name/)).not.toBeInTheDocument();
  expect(screen.queryByLabelText(/^Username/)).not.toBeInTheDocument();
});

test('reports a failed lookup', async () => {
  core.mentionNotifications.mockRejectedValue(new Error('denied'));

  render(MentionNotifications);

  expect(
    await screen.findByText('Those mention notification settings could not be saved.')
  ).toBeInTheDocument();
});
