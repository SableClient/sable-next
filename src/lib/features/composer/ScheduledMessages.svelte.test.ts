// @vitest-environment happy-dom

import { flushSync, mount, unmount } from 'svelte';
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
  document.body.replaceChildren();
  for (const toast of toasts.items) toasts.dismiss(toast.id);
  adoptQueue([]);
  scheduledMessages.mockReset();
  cancelScheduledMessage.mockReset();
  sendScheduledMessage.mockReset();
});

function serverMessage(delayId: string, body: string) {
  return { delay_id: delayId, body, formatted: null, delivery_ts: Date.now() + 60_000 };
}

async function render() {
  const instance = mount(ScheduledMessages, { target: document.body, props: { roomId: ROOM } });
  await vi.waitFor(() => {
    expect(document.querySelector('.summary')).not.toBeNull();
  });
  document.querySelector<HTMLButtonElement>('.summary')?.click();
  flushSync();
  return instance;
}

function bodies(): string[] {
  return [...document.querySelectorAll('li .body')].map((node) => node.textContent);
}

function press(label: string): void {
  document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`)?.click();
  flushSync();
}

test('deleting waits for the toast to close before cancelling on the server', async () => {
  scheduledMessages.mockResolvedValue([serverMessage('d1', 'hello later')]);
  cancelScheduledMessage.mockResolvedValue(undefined);
  const instance = await render();

  press('Delete');
  expect(bodies()).toEqual([]);
  expect(cancelScheduledMessage).not.toHaveBeenCalled();
  expect(toasts.items.at(-1)?.message).toBe('Scheduled message deleted');

  const toast = toasts.items.at(-1);
  if (toast) toasts.dismiss(toast.id);
  await vi.waitFor(() => {
    expect(cancelScheduledMessage).toHaveBeenCalledWith('d1');
  });
  await unmount(instance);
});

test('undoing a delete keeps the message and never cancels it', async () => {
  scheduledMessages.mockResolvedValue([serverMessage('d1', 'hello later')]);
  const instance = await render();

  press('Delete');
  toasts.items.at(-1)?.action?.run();
  flushSync();

  expect(bodies()).toEqual(['hello later']);
  expect(cancelScheduledMessage).not.toHaveBeenCalled();
  await unmount(instance);
});

test('a failed cancel puts the message back and says so', async () => {
  scheduledMessages.mockResolvedValue([serverMessage('d1', 'hello later')]);
  cancelScheduledMessage.mockRejectedValue(new Error('offline'));
  const instance = await render();

  press('Delete');
  const toast = toasts.items.at(-1);
  if (toast) toasts.dismiss(toast.id);

  await vi.waitFor(() => {
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('could not be deleted');
  });
  expect(bodies()).toEqual(['hello later']);
  await unmount(instance);
});

test('a failed send-now puts the message back and says so', async () => {
  scheduledMessages.mockResolvedValue([serverMessage('d1', 'hello later')]);
  sendScheduledMessage.mockRejectedValue(new Error('offline'));
  const instance = await render();

  press('Send now');

  await vi.waitFor(() => {
    expect(document.querySelector('[role="alert"]')?.textContent).toContain('could not be sent');
  });
  expect(bodies()).toEqual(['hello later']);
  await unmount(instance);
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
  const instance = await render();

  press('Delete');
  expect(scheduledQueue()).toEqual([]);

  toasts.items.at(-1)?.action?.run();
  flushSync();
  expect(scheduledQueue()).toEqual([queued]);
  await unmount(instance);
});
