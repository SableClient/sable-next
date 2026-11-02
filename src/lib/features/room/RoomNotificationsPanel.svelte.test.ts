// @vitest-environment happy-dom

import { fireEvent, render, screen } from '@testing-library/svelte';
import { expect, test, vi } from 'vitest';

import type { InboxItemView } from '#src/generated/protocol';

vi.mock('#lib/core/context.js');
vi.mock(
  './messages/MessagePreview.svelte',
  () => import('./RoomNotificationsPanelPreviewStub.test.svelte')
);

import { core } from '#lib/core/__mocks__/context.js';

import RoomNotificationsPanel from './RoomNotificationsPanel.svelte';

function item(eventId: string, body: string): InboxItemView {
  return {
    room_id: '!room',
    event_id: eventId,
    ts: 1,
    sender: '@alice:example.org',
    sender_name: 'Alice',
    body,
    highlight: true,
    is_direct: false,
    encrypted: false,
    read: true,
    thread_root: null,
  };
}

test('lists this room’s mentions, switches to every notification and jumps to one', async () => {
  const backfillInbox = vi.fn(() => Promise.resolve({ recorded: 0, has_more: false }));
  const inbox = vi.fn(() => Promise.resolve({ items: [item('$a', 'hello')], has_more: false }));
  Object.assign(core.rpc.notifications, {
    inbox,
    backfillInbox,
  });
  const onJump = vi.fn();

  render(RoomNotificationsPanel, { roomId: '!room', members: [], onJump, onClose: () => {} });

  expect(await screen.findByText('hello')).toBeInTheDocument();
  expect(backfillInbox).toHaveBeenCalledWith({ include_read: true, room_id: '!room' });
  expect(inbox).toHaveBeenCalledWith(
    expect.objectContaining({ filter: 'mentions', include_read: true, room_id: '!room' })
  );

  await fireEvent.click(screen.getByRole('button', { name: 'All' }));
  await vi.waitFor(() => {
    expect(inbox).toHaveBeenLastCalledWith(
      expect.objectContaining({ filter: 'all', room_id: '!room' })
    );
  });

  await fireEvent.input(screen.getByRole('searchbox', { name: 'Filter by sender or text' }), {
    target: { value: ' alice ' },
  });
  await vi.waitFor(() => {
    expect(inbox).toHaveBeenLastCalledWith(expect.objectContaining({ query: 'alice' }));
  });

  await fireEvent.click(screen.getByRole('button', { name: 'Open message in room' }));
  expect(onJump).toHaveBeenCalledWith('$a');
});
