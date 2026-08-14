// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import RoomComposer from './RoomComposer.svelte';

afterEach(() => {
  document.body.replaceChildren();
});

function textarea(): HTMLTextAreaElement {
  const element = document.querySelector('textarea');
  if (!(element instanceof HTMLTextAreaElement)) throw new Error('composer textarea not found');
  return element;
}

test('typing cleanup and drafts stay scoped to their room', async () => {
  const typing = vi.fn(async () => {});
  const send = vi.fn(async () => {});
  const first = mount(RoomComposer, {
    target: document.body,
    props: {
      roomId: '!first:example.org',
      onSend: send,
      onSendAttachment: send,
      onTyping: typing,
    },
  });
  const firstInput = textarea();
  firstInput.value = 'private draft';
  firstInput.dispatchEvent(new InputEvent('input', { bubbles: true }));
  await tick();
  expect(typing).toHaveBeenCalledWith('!first:example.org', true);

  await unmount(first);
  expect(typing).toHaveBeenLastCalledWith('!first:example.org', false);

  const second = mount(RoomComposer, {
    target: document.body,
    props: {
      roomId: '!second:example.org',
      onSend: send,
      onSendAttachment: send,
      onTyping: typing,
    },
  });
  expect(textarea().value).toBe('');
  await unmount(second);
});

test('queues any selected attachment, not only images', async () => {
  const attachment = vi.fn(async () => {});
  const instance = mount(RoomComposer, {
    target: document.body,
    props: {
      roomId: '!room:example.org',
      onSend: async () => {},
      onSendAttachment: attachment,
      onTyping: async () => {},
    },
  });
  const input = document.querySelector('input[type="file"]');
  if (!(input instanceof HTMLInputElement)) throw new Error('attachment input not found');
  const file = new File(['report'], 'report.pdf', { type: 'application/pdf' });
  Object.defineProperty(input, 'files', { configurable: true, value: [file] });

  input.dispatchEvent(new Event('change', { bubbles: true }));
  await tick();

  expect(input.accept).toBe('');
  expect(attachment).toHaveBeenCalledWith('!room:example.org', file);
  await unmount(instance);
});

test('queues files pasted into or dropped on the composer', async () => {
  const attachment = vi.fn(async () => {});
  const instance = mount(RoomComposer, {
    target: document.body,
    props: {
      roomId: '!room:example.org',
      onSend: async () => {},
      onSendAttachment: attachment,
      onTyping: async () => {},
    },
  });
  const pastedFile = new File(['pasted'], 'pasted.png', { type: 'image/png' });
  const droppedFile = new File(['dropped'], 'dropped.png', { type: 'image/png' });
  const paste = new Event('paste', { bubbles: true, cancelable: true });
  Object.defineProperty(paste, 'clipboardData', { value: { files: [pastedFile] } });
  const drop = new Event('drop', { bubbles: true, cancelable: true });
  Object.defineProperty(drop, 'dataTransfer', { value: { files: [droppedFile] } });

  textarea().dispatchEvent(paste);
  await tick();
  document.querySelector('.composer')?.dispatchEvent(drop);
  await tick();

  expect(paste.defaultPrevented).toBe(true);
  expect(drop.defaultPrevented).toBe(true);
  expect(attachment).toHaveBeenNthCalledWith(1, '!room:example.org', pastedFile);
  expect(attachment).toHaveBeenNthCalledWith(2, '!room:example.org', droppedFile);
  await unmount(instance);
});
