// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import FormattedBody from './FormattedBody.svelte';

afterEach(() => {
  document.body.replaceChildren();
});

test('opens Matrix links through the room-level handler', async () => {
  const onMatrixLink = vi.fn();
  const instance = mount(FormattedBody, {
    target: document.body,
    props: {
      body: 'unused',
      formatted: '<a href="matrix:roomid/room:example.org/e/event">Message</a>',
      onMatrixLink,
    },
  });
  await tick();

  document.querySelector<HTMLAnchorElement>('a')?.click();

  expect(onMatrixLink).toHaveBeenCalledWith(
    { kind: 'event', roomId: '!room:example.org', eventId: '$event' },
    expect.any(HTMLAnchorElement)
  );
  await unmount(instance);
});
