// @vitest-environment happy-dom

import { render, screen } from '@testing-library/svelte';
import { userEvent } from '@testing-library/user-event';
import { flushSync } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';
import { toasts } from '#lib/ui/toasts.svelte.js';

import { adoptQueue, scheduledQueue } from './scheduled-queue.svelte.js';
import ScheduledMessages from './ScheduledMessages.svelte';

const ROOM = '!room:example.org';

const scheduledMessages = vi.fn();
const cancelScheduledMessage = vi.fn();
const sendScheduledMessage = vi.fn();
Object.assign(core, { scheduledMessages, cancelScheduledMessage, sendScheduledMessage });

afterEach(() => {
  for (const toast of toasts.items) toasts.dismiss(toast.id);
  adoptQueue([]);
  scheduledMessages.mockReset();
  cancelScheduledMessage.mockReset();
  sendScheduledMessage.mockReset();
});

function serverMessage(delayId: string, body: string) {
  return { delay_id: delayId, body, formatted: null, delivery_ts: Date.now() + 60_000 };
}

const user = userEvent.setup();

async function setup(): Promise<void> {
  render(ScheduledMessages, { roomId: ROOM });
  await user.click(await screen.findByRole('button', { name: /scheduled$/ }));
}

function bodies(): string[] {
  return [...document.querySelectorAll('li .preview')].map((node) => node.textContent);
}

async function choose(body: string, action: string): Promise<void> {
  await user.click(
    screen.getByRole('button', { name: `Actions for the scheduled message “${body}”` })
  );
  await user.click(await screen.findByRole('menuitem', { name: action }));
  await vi.waitFor(() => {
    expect(screen.queryByRole('menuitem')).not.toBeInTheDocument();
  });
}

test('deleting waits for the toast to close before cancelling on the server', async () => {
  scheduledMessages.mockResolvedValue([serverMessage('d1', 'hello later')]);
  cancelScheduledMessage.mockResolvedValue(undefined);
  await setup();

  await choose('hello later', 'Delete');
  expect(bodies()).toEqual([]);
  expect(cancelScheduledMessage).not.toHaveBeenCalled();
  expect(toasts.items.at(-1)?.message).toBe('Scheduled message deleted');

  const toast = toasts.items.at(-1);
  if (toast) toasts.dismiss(toast.id);
  await vi.waitFor(() => {
    expect(cancelScheduledMessage).toHaveBeenCalledWith('d1');
  });
});

test('undoing a delete keeps the message and never cancels it', async () => {
  scheduledMessages.mockResolvedValue([serverMessage('d1', 'hello later')]);
  await setup();

  await choose('hello later', 'Delete');
  toasts.items.at(-1)?.action?.run();
  flushSync();

  expect(bodies()).toEqual(['hello later']);
  expect(cancelScheduledMessage).not.toHaveBeenCalled();
});

test('a failed cancel puts the message back and says so', async () => {
  scheduledMessages.mockResolvedValue([serverMessage('d1', 'hello later')]);
  cancelScheduledMessage.mockRejectedValue(new Error('offline'));
  await setup();

  await choose('hello later', 'Delete');
  const toast = toasts.items.at(-1);
  if (toast) toasts.dismiss(toast.id);

  expect(await screen.findByRole('alert')).toHaveTextContent('could not be deleted');
  expect(bodies()).toEqual(['hello later']);
});

test('a failed send-now puts the message back and says so', async () => {
  scheduledMessages.mockResolvedValue([serverMessage('d1', 'hello later')]);
  sendScheduledMessage.mockRejectedValue(new Error('offline'));
  await setup();

  await choose('hello later', 'Send now');

  expect(await screen.findByRole('alert')).toHaveTextContent('could not be sent');
  expect(bodies()).toEqual(['hello later']);
});

test('sending a queued message now takes it off the queue, and a failure puts it back', async () => {
  scheduledMessages.mockResolvedValue([]);
  const sendMessage = vi.fn().mockRejectedValue(new Error('offline'));
  Object.assign(core, { sendMessage });
  const queued = {
    id: 'q1',
    roomId: ROOM,
    body: 'queued',
    formatted: null,
    dueTs: Date.now() + 60_000,
    owner: 'DEV',
  };
  adoptQueue([queued]);
  await setup();

  await choose('queued', 'Send now');

  expect(await screen.findByRole('alert')).toBeInTheDocument();
  expect(sendMessage).toHaveBeenCalledWith(ROOM, 'queued', { formatted: null });
  expect(scheduledQueue()).toEqual([queued]);
});

test('deleting a queued message can be undone', async () => {
  scheduledMessages.mockResolvedValue([]);
  const queued = {
    id: 'q1',
    roomId: ROOM,
    body: 'queued',
    formatted: null,
    dueTs: Date.now() + 60_000,
    owner: 'DEV',
  };
  adoptQueue([queued]);
  await setup();

  await choose('queued', 'Delete');
  expect(scheduledQueue()).toEqual([]);

  toasts.items.at(-1)?.action?.run();
  flushSync();
  expect(scheduledQueue()).toEqual([queued]);
});
