// @vitest-environment happy-dom

import { mount, tick, unmount } from 'svelte';
import { afterEach, expect, test, vi } from 'vitest';

import MessageContextMenu from '#lib/features/room/MessageContextMenu.svelte';

import ForumThreadItem from './ForumThreadItem.svelte';
import type { ForumThread } from './forum-threads';

const thread: ForumThread = {
  id: 'thread-row',
  eventId: '$thread:example.org',
  sender: '@alice:example.org',
  senderName: 'Alice',
  senderAvatar: null,
  isOwn: true,
  editable: true,
  html: null,
  mediaCaption: false,
  createdAt: 0,
  preview: 'Topic body',
  replyCount: 2,
  lastActivityAt: 0,
  lastBody: null,
  lastSenderName: null,
  unread: false,
};

afterEach(() => {
  document.body.replaceChildren();
});

test('uses the timeline context menu for a forum thread', async () => {
  const onOpen = vi.fn();
  const onEdit = vi.fn();
  const onDelete = vi.fn();
  const item = mount(ForumThreadItem, {
    target: document.body,
    props: {
      thread,
      onOpen,
      canDelete: true,
      onEdit,
      onDelete,
      roomId: '!forum:example.org',
      onReact: vi.fn(),
      loadImagePacks: vi.fn(() => Promise.resolve([])),
      onCopyLink: vi.fn(),
    },
  });
  const menu = mount(MessageContextMenu, { target: document.body });
  await tick();

  const card = document.querySelector('.forum-thread-card');
  if (!card) throw new Error('forum thread card was not rendered');
  card.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
  await tick();

  const context = document.querySelector<HTMLElement>('.message-menu');
  if (!context) throw new Error('timeline context menu was not rendered');
  expect(context.textContent).toContain('Reply in thread');
  expect(context.textContent).toContain('Edit message');
  expect(context.textContent).toContain('Copy message');
  expect(context.textContent).toContain('Delete message');

  const edit = [...context.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (entry) => entry.textContent.trim() === 'Edit message'
  );
  if (!edit) throw new Error('edit action was not rendered');
  edit.click();
  expect(onEdit).toHaveBeenCalledWith(thread);

  const remove = [...context.querySelectorAll<HTMLElement>('[role="menuitem"]')].find(
    (entry) => entry.textContent.trim() === 'Delete message'
  );
  if (!remove) throw new Error('delete action was not rendered');
  remove.click();
  await tick();
  expect(document.body.textContent).toContain('Delete thread?');

  await unmount(menu);
  await unmount(item);
});
