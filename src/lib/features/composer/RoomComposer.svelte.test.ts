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

test('stages any selected attachment, not only images, and sends it on submit', async () => {
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

  expect(document.querySelector('.staged-name')?.textContent).toBe('report.pdf');
  expect(attachment).not.toHaveBeenCalled();

  document.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true }));
  await tick();

  expect(attachment).toHaveBeenCalledWith('!room:example.org', file);
  await unmount(instance);
});

test('stages files pasted into or dropped on the composer, and drops one on demand', async () => {
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
  expect(
    Array.from(document.querySelectorAll('.staged-name')).map((node) => node.textContent)
  ).toEqual(['pasted.png', 'dropped.png']);

  const remove = document.querySelector('.staged-item button');
  if (!(remove instanceof HTMLButtonElement)) throw new Error('remove control not found');
  remove.click();
  await tick();

  document.querySelector('form')?.dispatchEvent(new Event('submit', { bubbles: true }));
  await tick();

  expect(attachment).toHaveBeenCalledTimes(1);
  expect(attachment).toHaveBeenCalledWith('!room:example.org', droppedFile);
  await unmount(instance);
});

test('the send verb stays disabled until there is something to send', async () => {
  const instance = mount(RoomComposer, {
    target: document.body,
    props: {
      roomId: '!room:example.org',
      onSend: async () => {},
      onSendAttachment: async () => {},
      onTyping: async () => {},
    },
  });
  const send = document.querySelector('button[type="submit"]');
  if (!(send instanceof HTMLButtonElement)) throw new Error('send control not found');
  expect(send.disabled).toBe(true);

  const input = textarea();
  input.value = 'ready';
  input.dispatchEvent(new InputEvent('input', { bubbles: true }));
  await tick();

  expect(send.disabled).toBe(false);
  await unmount(instance);
});
