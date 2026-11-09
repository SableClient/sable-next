// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';
import type { CoreEvent } from '#src/generated/protocol';

import type { SidebarItem } from './sidebar-layout.js';
import { SpaceSidebar } from './sidebar-layout.svelte.js';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

function fakeCore(overrides: Partial<Record<string, unknown>> = {}) {
  const listeners = new Set<(event: CoreEvent) => void>();
  const core = {
    subscribeEvents: (listener: (event: CoreEvent) => void) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    rpc: {
      spaces: {
        sidebar: vi.fn(() => Promise.resolve<SidebarItem[]>([])),
        setSidebar: vi.fn(() => Promise.resolve()),
        ...overrides,
      },
    },
  };

  return {
    core: core as unknown as CoreClient,
    calls: core.rpc.spaces,
    emit(event: CoreEvent) {
      for (const listener of listeners) listener(event);
    },
    listenerCount: () => listeners.size,
  };
}

const folder: SidebarItem = {
  kind: 'folder',
  id: 'f',
  name: 'Work',
  icon: null,
  content: ['!a:example.org'],
};
const lifted: SidebarItem[] = [{ kind: 'space', room_id: '!a:example.org' }];

test('loads the stored layout', async () => {
  const { core } = fakeCore({ sidebar: vi.fn(() => Promise.resolve([folder])) });
  const sidebar = new SpaceSidebar();

  await sidebar.start(core);

  expect(sidebar.items).toEqual([folder]);
});

test('takes a layout another device wrote', async () => {
  const harness = fakeCore();
  const sidebar = new SpaceSidebar();
  await sidebar.start(harness.core);

  harness.emit({ type: 'space_sidebar_changed', items: [folder] });

  expect(sidebar.items).toEqual([folder]);
});

test('keeps a sync layout when an older initial read finishes', async () => {
  const read = Promise.withResolvers<SidebarItem[]>();
  const harness = fakeCore({ sidebar: vi.fn(() => read.promise) });
  const sidebar = new SpaceSidebar();
  const starting = sidebar.start(harness.core);

  harness.emit({ type: 'space_sidebar_changed', items: [folder] });
  read.resolve([]);
  await starting;

  expect(sidebar.items).toEqual([folder]);
  expect(harness.calls.setSidebar).not.toHaveBeenCalled();
});

test('does not save a layout before the initial read finishes', async () => {
  const read = Promise.withResolvers<SidebarItem[]>();
  const harness = fakeCore({ sidebar: vi.fn(() => read.promise) });
  const sidebar = new SpaceSidebar();
  const starting = sidebar.start(harness.core);

  sidebar.write(lifted);

  expect(harness.calls.setSidebar).not.toHaveBeenCalled();
  read.resolve([folder]);
  await starting;
  expect(sidebar.items).toEqual([folder]);
});

test('does not save a fallback layout after a failed read', async () => {
  const harness = fakeCore({ sidebar: vi.fn(() => Promise.reject(new Error('store closed'))) });
  const sidebar = new SpaceSidebar();
  vi.spyOn(console, 'debug').mockImplementation(() => undefined);
  await sidebar.start(harness.core);

  sidebar.write(lifted);

  expect(harness.calls.setSidebar).not.toHaveBeenCalled();
  expect(sidebar.items).toEqual([]);

  harness.emit({ type: 'space_sidebar_changed', items: [folder] });
  sidebar.write(lifted);
  expect(harness.calls.setSidebar).toHaveBeenCalledWith({ items: lifted });
});

test('shows a write before it is stored', async () => {
  const harness = fakeCore();
  const sidebar = new SpaceSidebar();
  await sidebar.start(harness.core);

  sidebar.write([folder]);

  expect(sidebar.items).toEqual([folder]);
  expect(harness.calls.setSidebar).toHaveBeenCalledWith({ items: [folder] });
});

test('puts the previous layout back when the write is refused', async () => {
  const harness = fakeCore({ setSidebar: vi.fn(() => Promise.reject(new Error('denied'))) });
  const sidebar = new SpaceSidebar();
  await sidebar.start(harness.core);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  sidebar.write([folder]);
  await vi.waitFor(() => {
    expect(sidebar.items).toEqual([]);
  });
});

test('ignores a layout from a sync that predates its own write', async () => {
  const harness = fakeCore({ sidebar: vi.fn(() => Promise.resolve([folder])) });
  const sidebar = new SpaceSidebar();
  await sidebar.start(harness.core);

  sidebar.write(lifted);
  harness.emit({ type: 'space_sidebar_changed', items: [folder] });

  expect(sidebar.items).toEqual(lifted);
});

test('settles once its own write comes back', async () => {
  const harness = fakeCore({ sidebar: vi.fn(() => Promise.resolve([folder])) });
  const sidebar = new SpaceSidebar();
  await sidebar.start(harness.core);

  sidebar.write(lifted);
  harness.emit({
    type: 'space_sidebar_changed',
    items: [{ kind: 'space', room_id: '!a:example.org' }],
  });
  harness.emit({ type: 'space_sidebar_changed', items: [folder] });

  expect(sidebar.items).toEqual([folder]);
});

test('takes another device change made after its own write was stored', async () => {
  const harness = fakeCore({ sidebar: vi.fn(() => Promise.resolve([])) });
  const sidebar = new SpaceSidebar();
  await sidebar.start(harness.core);

  sidebar.write(lifted);
  await vi.waitFor(() => {
    expect(harness.calls.setSidebar).toHaveBeenCalled();
  });
  await Promise.resolve();
  harness.emit({ type: 'space_sidebar_changed', items: [folder] });

  expect(sidebar.items).toEqual([folder]);
});

test('a rejected write does not undo a newer one', async () => {
  let refuse: ((error: Error) => void) | undefined;
  const harness = fakeCore({
    setSidebar: vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise((_, reject) => {
            refuse = reject;
          })
      )
      .mockImplementation(() => Promise.resolve()),
  });
  const sidebar = new SpaceSidebar();
  await sidebar.start(harness.core);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  sidebar.write([folder]);
  sidebar.write(lifted);
  refuse?.(new Error('denied'));
  await Promise.resolve();

  expect(sidebar.items).toEqual(lifted);
});

test('persists which folders are open and forgets ones that are gone', async () => {
  const harness = fakeCore({ sidebar: vi.fn(() => Promise.resolve([folder])) });
  const sidebar = new SpaceSidebar();
  await sidebar.start(harness.core);

  sidebar.toggleFolder('f');
  expect(sidebar.openFolders.has('f')).toBe(true);
  expect(localStorage.getItem('sable-open-space-folders')).toBe('["f"]');

  const restored = new SpaceSidebar();
  expect(restored.openFolders.has('f')).toBe(true);

  sidebar.write([{ kind: 'space', room_id: '!a:example.org' }]);
  expect(sidebar.openFolders.has('f')).toBe(false);
  expect(localStorage.getItem('sable-open-space-folders')).toBe('[]');
});

test('collapses every open folder at once', () => {
  const sidebar = new SpaceSidebar();
  sidebar.toggleFolder('f');
  sidebar.toggleFolder('g');

  sidebar.collapseAllFolders();

  expect(sidebar.openFolders.size).toBe(0);
  expect(localStorage.getItem('sable-open-space-folders')).toBe('[]');
});

test('drops its subscription and layout on stop', async () => {
  const harness = fakeCore({ sidebar: vi.fn(() => Promise.resolve([folder])) });
  const sidebar = new SpaceSidebar();
  await sidebar.start(harness.core);

  sidebar.stop();

  expect(sidebar.items).toEqual([]);
  expect(harness.listenerCount()).toBe(0);

  harness.emit({ type: 'space_sidebar_changed', items: [folder] });
  expect(sidebar.items).toEqual([]);
});

test('a late read from a previous session does not overwrite the current one', async () => {
  let release: ((items: SidebarItem[]) => void) | undefined;
  const harness = fakeCore({
    sidebar: vi.fn(
      () =>
        new Promise<SidebarItem[]>((resolve) => {
          release = resolve;
        })
    ),
  });
  const sidebar = new SpaceSidebar();
  const pending = sidebar.start(harness.core);

  sidebar.stop();
  release?.([folder]);
  await pending;

  expect(sidebar.items).toEqual([]);
});
