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
    props: { roomId: '!first:example.org', onSend: send, onTyping: typing },
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
    props: { roomId: '!second:example.org', onSend: send, onTyping: typing },
  });
  expect(textarea().value).toBe('');
  await unmount(second);
});
