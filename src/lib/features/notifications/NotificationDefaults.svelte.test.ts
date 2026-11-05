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
  rtc_user: true,
  rtc_room: false,
};

test('shows each event kind at its account state', async () => {
  core.rpc.notifications.eventNotifications.mockResolvedValue(loaded);

  render(NotificationDefaults);

  await vi.waitFor(() => {
    expect(screen.getByLabelText('Reactions to your messages')).toHaveTextContent('Off');
  });
  expect(screen.getByLabelText('Invitations to you')).toHaveTextContent('Notify');
  expect(screen.getByLabelText('Incoming calls')).toHaveTextContent('Notify');
  expect(screen.getByLabelText('Calls that notify the room')).toHaveTextContent('Off');
  expect(screen.getByLabelText('Legacy calls')).toHaveTextContent('Notify');
  expect(core.rpc.notifications.setEventNotification).not.toHaveBeenCalled();
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

test('explains when the server has no separate RTC controls', async () => {
  core.rpc.notifications.eventNotifications.mockResolvedValue({
    ...loaded,
    rtc_user: null,
    rtc_room: null,
  });
  render(NotificationDefaults);
  expect(await screen.findByText('Incoming calls')).toBeInTheDocument();
  expect(screen.queryByLabelText('Incoming calls')).not.toBeInTheDocument();
  expect(
    screen.getAllByText(
      'Your homeserver has no separate MatrixRTC call controls. Invitations may use your mention settings.'
    )
  ).toHaveLength(2);
  expect(core.rpc.notifications.setEventNotification).not.toHaveBeenCalled();
});

test('turning RTC calls off changes only the selected control', async () => {
  core.rpc.notifications.eventNotifications.mockResolvedValue(loaded);
  core.rpc.notifications.setEventNotification.mockResolvedValue(null);
  const user = userEvent.setup();
  render(NotificationDefaults);
  await user.click(await screen.findByLabelText('Incoming calls'));
  await user.click(await screen.findByRole('option', { name: 'Off' }));
  expect(core.rpc.notifications.setEventNotification).toHaveBeenCalledExactlyOnceWith({
    event: 'rtc_user',
    enabled: false,
  });
  expect(screen.getByLabelText('Legacy calls')).toHaveTextContent('Notify');
});
