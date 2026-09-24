// @vitest-environment happy-dom

import { flushSync, mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

import { core } from '#lib/core/__mocks__/context.js';

import ThreadList from './ThreadList.svelte';

const listThreads = vi.fn();
Object.assign(core, { listThreads });

afterEach(() => {
  document.body.replaceChildren();
  listThreads.mockReset();
});

function root(id: string, body: string) {
  return { event_id: id, sender: '@ana:example.org', body, timestamp: null };
}

test('lists thread roots page by page and opens the one picked', async () => {
  listThreads
    .mockResolvedValueOnce({ roots: [root('$a', 'First topic')], next_batch: 'next' })
    .mockResolvedValueOnce({ roots: [root('$b', 'Second topic')], next_batch: null });
  const onOpenThread = vi.fn();
  const instance = mount(ThreadList, {
    target: document.body,
    props: { roomId: '!room:example.org', members: [], onOpenThread, onClose: vi.fn() },
  });
  await vi.waitFor(() => {
    expect(document.querySelectorAll('.thread-root')).toHaveLength(1);
  });

  document.querySelector<HTMLButtonElement>('.thread-list-more button')?.click();
  await vi.waitFor(() => {
    expect(document.querySelectorAll('.thread-root')).toHaveLength(2);
  });
  expect(listThreads).toHaveBeenLastCalledWith('!room:example.org', 'next');
  expect(document.querySelector('.thread-list-more')).toBeNull();

  document.querySelectorAll<HTMLButtonElement>('.thread-root')[1]?.click();
  flushSync();
  expect(onOpenThread).toHaveBeenCalledWith('$b');
  await unmount(instance);
});

test('says so when a room has no threads', async () => {
  listThreads.mockResolvedValueOnce({ roots: [], next_batch: null });
  const instance = mount(ThreadList, {
    target: document.body,
    props: { roomId: '!room:example.org', members: [], onOpenThread: vi.fn(), onClose: vi.fn() },
  });
  await tick();
  await vi.waitFor(() => {
    expect(document.querySelector('.thread-list-status')).not.toBeNull();
  });
  await unmount(instance);
});
