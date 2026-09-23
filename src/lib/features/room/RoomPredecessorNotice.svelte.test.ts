// @vitest-environment happy-dom

import { flushSync, mount, unmount } from 'svelte';
import { expect, test, vi } from 'vitest';

import RoomPredecessorNotice from './RoomPredecessorNotice.svelte';

test('says the room continues another and opens it', async () => {
  const onOpen = vi.fn();
  const instance = mount(RoomPredecessorNotice, { target: document.body, props: { onOpen } });

  expect(document.body.textContent).toContain(
    'This room is a continuation of another conversation.'
  );
  const button = Array.from(document.querySelectorAll('button')).find(
    (candidate) => candidate.textContent.trim() === 'View older messages'
  );
  button?.click();
  flushSync();

  expect(onOpen).toHaveBeenCalledOnce();
  await unmount(instance);
});
