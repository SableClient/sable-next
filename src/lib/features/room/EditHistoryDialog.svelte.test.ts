// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  useRoomList: () => ({ rooms: [] }),
}));

import EditHistoryDialog from './EditHistoryDialog.svelte';

afterEach(() => {
  vi.unstubAllGlobals();
  document.body.replaceChildren();
});

const versions = [
  { event_id: '$original', timestamp: 1, body: 'helo', html: '<p>helo</p>' },
  { event_id: '$edit', timestamp: 2, body: 'hello', html: '<p><b>hello</b></p>' },
];

test('renders every version as a message body and replies to the one picked', async () => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  const onReply = vi.fn();
  const instance = mount(EditHistoryDialog, {
    target: document.body,
    props: { open: true, versions, onReply },
  });
  await tick();

  const bodies = [...document.querySelectorAll('.edit-history-version .formatted-body')];
  expect(bodies.map((body) => body.textContent.trim())).toEqual(['helo', 'hello']);
  expect(bodies[1].querySelector('b')?.textContent).toBe('hello');
  expect(document.querySelectorAll('.edit-history-original')).toHaveLength(1);

  const replies = document.querySelectorAll<HTMLButtonElement>('.edit-history-reply');
  replies[0].click();
  expect(onReply).toHaveBeenCalledWith(versions[0]);

  await unmount(instance);
});

test('only the original can start a thread, and any version can be deleted', async () => {
  vi.stubGlobal('matchMedia', () => ({
    matches: false,
    addEventListener: () => {},
    removeEventListener: () => {},
  }));
  const onThread = vi.fn();
  const onDelete = vi.fn();
  const instance = mount(EditHistoryDialog, {
    target: document.body,
    props: { open: true, versions, onThread, onDelete },
  });
  await tick();

  const threads = document.querySelectorAll<HTMLButtonElement>('.edit-history-thread');
  expect(threads).toHaveLength(1);
  threads[0].click();
  expect(onThread).toHaveBeenCalledWith(versions[0]);

  await unmount(instance);
  const again = mount(EditHistoryDialog, {
    target: document.body,
    props: { open: true, versions, onThread, onDelete },
  });
  await tick();
  document.querySelectorAll<HTMLButtonElement>('.edit-history-delete')[1].click();
  expect(onDelete).toHaveBeenCalledWith(versions[1]);

  await unmount(again);
});
