// @vitest-environment happy-dom

import type { ResolvedItem } from '#lib/rooms/timeline-item.js';
import { render, screen } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

vi.mock('#lib/core/context.js');

vi.mock('#lib/rooms/room-list.svelte.js', () => ({
  useRoomList: () => ({ rooms: [] }),
}));

vi.mock('#lib/personas/personas.svelte.js', () => ({
  usePersonaStore: () => ({ personas: [], load: () => Promise.resolve() }),
}));

vi.mock('#lib/rooms/presence.svelte.js', async () => {
  const actual = await vi.importActual<typeof import('#lib/rooms/presence.svelte.js')>(
    '#lib/rooms/presence.svelte.js'
  );
  return { ...actual, usePresenceStore: () => ({ get: () => null, peek: () => null }) };
});

import { guardTouchClicks } from '#lib/ui/trailing-click.js';

import TimelineItemHarness from './TimelineItemHarness.test.svelte';
import { core, user, resetTimelineItemTest, item, imageItem } from './timeline-item-fixtures';
import { withRowFields } from './row-fixtures.js';

afterEach(resetTimelineItemTest);

test('a message waiting for the server shows a sending status until it is sent', async () => {
  const sending: ResolvedItem = {
    ...item(false),
    event_id: null,
    transaction_id: 'txn-text',
    is_own: true,
    send_state: { status: 'sending', progress: null },
  };
  const view = render(TimelineItemHarness, {
    props: { core, item: { item: sending, collapsed: false } },
  });
  await tick();

  expect(screen.getByRole('status')).toHaveTextContent('Sending…');

  await view.rerender({
    core,
    item: { item: { ...sending, event_id: '$sent', send_state: null }, collapsed: false },
  });
  await tick();

  expect(screen.queryByRole('status')).toBeNull();
});

test('shows an indeterminate upload bar until the core reports progress', async () => {
  const upload: ResolvedItem = {
    ...imageItem(),
    event_id: null,
    is_own: true,
    send_state: { status: 'sending', progress: null },
  };
  render(TimelineItemHarness, {
    props: { core, item: { item: upload, collapsed: false } },
  });
  await tick();

  expect(screen.getByRole('progressbar')).toHaveAttribute('data-indeterminate');
});

test('a right click on a message still sending does not open the browser menu', async () => {
  const sending: ResolvedItem = {
    ...item(false),
    event_id: null,
    transaction_id: 'txn-text',
    is_own: true,
    send_state: { status: 'sending', progress: null },
  };
  render(TimelineItemHarness, { props: { core, item: { item: sending, collapsed: false } } });
  await tick();

  const native = new MouseEvent('contextmenu', { bubbles: true, cancelable: true });
  document.querySelector('article')?.dispatchEvent(native);

  expect(native.defaultPrevented).toBe(true);
});

test('cancels an upload that is still sending', async () => {
  const onCancelSend = vi.fn();
  const upload: ResolvedItem = {
    ...imageItem(),
    event_id: null,
    transaction_id: 'txn-upload',
    is_own: true,
    send_state: { status: 'sending', progress: { index: 0, current: 10, total: 100 } },
  };
  render(TimelineItemHarness, {
    props: { core, item: { item: upload, collapsed: false, onCancelSend } },
  });
  await tick();
  const unguard = guardTouchClicks();

  await user.click(screen.getByRole('button', { name: 'Cancel' }));

  unguard();
  expect(onCancelSend).toHaveBeenCalledWith('txn-upload');
});

test('fills one bar across a gallery and names the item uploading', async () => {
  const gallery: ResolvedItem = withRowFields({
    ...item(false),
    event_id: null,
    is_own: true,
    send_state: { status: 'sending', progress: { index: 1, current: 50, total: 100 } },
    content: {
      kind: 'gallery',
      body: '',
      html: '',
      items: ['a', 'b', 'c', 'd'].map((name) => ({
        kind: 'file' as const,
        filename: `${name}.zip`,
        caption: null,
        source: `mxc://example.org/${name}`,
        mime: null,
        size: null,
      })),
    },
  });
  render(TimelineItemHarness, {
    props: { core, item: { item: gallery, collapsed: false } },
  });
  await tick();

  expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '37.5');
  expect(document.querySelector('.transfer-count')?.textContent.trim()).toBe('2 of 4');
});
