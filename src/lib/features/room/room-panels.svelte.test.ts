import { expect, test } from 'vitest';
import { RoomPanels } from './room-panels.svelte.js';

test('opening a thread closes competing panels', () => {
  const panels = new RoomPanels();
  panels.toggleAttachments();
  panels.openThread('$root');
  expect(panels.threadRootId).toBe('$root');
  expect(panels.attachmentsOpen || panels.threadsOpen || panels.searchOpen).toBe(false);
});

test.each([true, false])('leaving a thread preserves members open=%s', (open) => {
  const panels = new RoomPanels();
  panels.desktopMembersOpen = open;
  panels.openThread('$root');
  panels.threadRootId = null;
  expect(panels.desktopMembersOpen).toBe(open);
});

test('switching panel types preserves the open thread and resets on room change', () => {
  const panels = new RoomPanels();
  panels.openThread('$root');
  panels.toggleSearch();
  panels.toggleThreads();
  expect(panels.searchOpen).toBe(false);
  expect(panels.threadsOpen).toBe(true);
  expect(panels.threadRootId).toBe('$root');
  panels.reset();
  expect(panels.threadRootId).toBeNull();
  expect(panels.threadsOpen).toBe(false);
});
