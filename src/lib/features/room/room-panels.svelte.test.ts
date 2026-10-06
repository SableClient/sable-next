import { expect, test, vi } from 'vitest';
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

test('only one panel is open at a time', () => {
  const panels = new RoomPanels();
  panels.openThread('$root');
  panels.toggleSearch();
  expect(panels.threadRootId).toBeNull();
  expect(panels.searchOpen).toBe(true);
  panels.toggleWidgets();
  expect(panels.searchOpen).toBe(false);
  expect(panels.widgetsOpen).toBe(true);
  expect(panels.toggleMembers(true)).toBe(true);
  expect(panels.widgetsOpen).toBe(false);
  panels.toggleThreads();
  expect(panels.desktopMembersOpen).toBe(false);
  expect(panels.threadsOpen).toBe(true);
  panels.openThread('$root');
  expect(panels.threadsOpen).toBe(false);
  panels.reset();
  expect(panels.threadRootId).toBeNull();
});

test('toggling the open panel closes it', () => {
  const panels = new RoomPanels();
  panels.toggleWidgets();
  panels.toggleWidgets();
  expect(panels.widgetsOpen).toBe(false);
  expect(panels.toggleMembers(false)).toBe(true);
  expect(panels.toggleMembers(false)).toBe(false);
});

test('a closed desktop member list stays closed in the next room', () => {
  const first = new RoomPanels();
  first.closeMembers(true);
  expect(new RoomPanels().desktopMembersOpen).toBe(false);
  first.toggleMembers(true);
  expect(new RoomPanels().desktopMembersOpen).toBe(true);
});

test('the desktop member list preference survives a reload', async () => {
  const stored = new Map<string, string>();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => stored.get(key) ?? null,
    setItem: (key: string, value: string) => {
      stored.set(key, value);
    },
  });
  new RoomPanels().closeMembers(true);
  vi.resetModules();
  const reloaded = await import('./room-panels.svelte.js');
  expect(new reloaded.RoomPanels().desktopMembersOpen).toBe(false);
  new reloaded.RoomPanels().toggleMembers(true);
  vi.resetModules();
  const again = await import('./room-panels.svelte.js');
  expect(new again.RoomPanels().desktopMembersOpen).toBe(true);
  vi.unstubAllGlobals();
});
