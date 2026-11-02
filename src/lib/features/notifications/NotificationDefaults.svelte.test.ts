// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import { core as baseCore } from '#lib/core/__mocks__/context.js';

const core = baseCore;
Object.assign(core.rpc.notifications, {
  defaultModes: vi.fn(() => Promise.resolve({ direct: 'all', group: 'mentions' })),
  masterMute: vi.fn(() => Promise.resolve(false)),
  eventNotifications: vi.fn<() => Promise<Record<string, boolean | null>>>(),
  setEventNotification: vi.fn<(params: { event: string; enabled: boolean }) => Promise<void>>(),
});
Object.assign(core.rpc.notifications, core);

import NotificationDefaults from './NotificationDefaults.svelte';

afterEach(() => {
  vi.clearAllMocks();
});

const loaded = {
  membership: false,
  reactions: false,
  edits: false,
  notices: false,
  invites: true,
  calls: true,
};

test('shows each event kind at its account state', async () => {
  core.rpc.notifications.eventNotifications.mockResolvedValue(loaded);

  render(NotificationDefaults);

  await vi.waitFor(() => {
    expect(screen.getByLabelText('Reactions to your messages')).toHaveTextContent('Off');
  });
  expect(screen.getByLabelText('Invitations to you')).toHaveTextContent('Notify');
  expect(screen.getByLabelText('Incoming calls')).toHaveTextContent('Notify');
});

test('hides an event kind the server has no rule for', async () => {
  core.rpc.notifications.eventNotifications.mockResolvedValue({ ...loaded, edits: null });

  render(NotificationDefaults);

  await vi.waitFor(() => {
    expect(screen.getByLabelText('Reactions to your messages')).toBeInTheDocument();
  });
  expect(screen.queryByLabelText('Message edits')).not.toBeInTheDocument();
});

test('turning reactions on saves that one event', async () => {
  core.rpc.notifications.eventNotifications.mockResolvedValue(loaded);
  core.rpc.notifications.setEventNotification.mockResolvedValue(null);
  const user = userEvent.setup();

  render(NotificationDefaults);

  await user.click(await screen.findByLabelText('Reactions to your messages'));
  await user.click(await screen.findByRole('option', { name: 'Notify' }));

  expect(core.rpc.notifications.setEventNotification).toHaveBeenCalledWith({
    event: 'reactions',
    enabled: true,
  });
});
