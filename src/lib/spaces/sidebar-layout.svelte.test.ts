// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';

import type { CoreClient } from '#lib/core/client.svelte.js';
import type { CoreEvent } from '#src/generated/CoreEvent';

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
    commands: {
      spaceSidebar: vi.fn(() => Promise.resolve<SidebarItem[]>([])),
      setSpaceSidebar: vi.fn(() => Promise.resolve()),
      ...overrides,
    },
  };

  return {
    core: core as unknown as CoreClient,
    calls: core.commands,
    emit(event: CoreEvent) {
      for (const listener of listeners) listener(event);
    },
    listenerCount: () => listeners.size,
  };
}

const folder: SidebarItem = { kind: 'folder', id: 'f', name: 'Work', content: ['!a:example.org'] };
const lifted: SidebarItem[] = [{ kind: 'space', room_id: '!a:example.org' }];

test('loads the stored layout', async () => {
  const { core } = fakeCore({ spaceSidebar: vi.fn(() => Promise.resolve([folder])) });
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

test('shows a write before it is stored', async () => {
  const harness = fakeCore();
  const sidebar = new SpaceSidebar();
  await sidebar.start(harness.core);

  sidebar.write([folder]);

  expect(sidebar.items).toEqual([folder]);
  expect(harness.calls.setSpaceSidebar).toHaveBeenCalledWith([folder]);
});

test('puts the previous layout back when the write is refused', async () => {
  const harness = fakeCore({ setSpaceSidebar: vi.fn(() => Promise.reject(new Error('denied'))) });
  const sidebar = new SpaceSidebar();
  await sidebar.start(harness.core);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);

  sidebar.write([folder]);
  await vi.waitFor(() => {
    expect(sidebar.items).toEqual([]);
  });
});

test('ignores a layout from a sync that predates its own write', async () => {
  const harness = fakeCore({ spaceSidebar: vi.fn(() => Promise.resolve([folder])) });
  const sidebar = new SpaceSidebar();
  await sidebar.start(harness.core);

  sidebar.write(lifted);
  harness.emit({ type: 'space_sidebar_changed', items: [folder] });

  expect(sidebar.items).toEqual(lifted);
});

test('settles once its own write comes back', async () => {
  const harness = fakeCore({ spaceSidebar: vi.fn(() => Promise.resolve([folder])) });
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
  const harness = fakeCore({ spaceSidebar: vi.fn(() => Promise.resolve([])) });
  const sidebar = new SpaceSidebar();
  await sidebar.start(harness.core);

  sidebar.write(lifted);
  await vi.waitFor(() => {
    expect(harness.calls.setSpaceSidebar).toHaveBeenCalled();
  });
  await Promise.resolve();
  harness.emit({ type: 'space_sidebar_changed', items: [folder] });

  expect(sidebar.items).toEqual([folder]);
});

test('a rejected write does not undo a newer one', async () => {
  let refuse: ((error: Error) => void) | undefined;
  const harness = fakeCore({
    setSpaceSidebar: vi
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
  const harness = fakeCore({ spaceSidebar: vi.fn(() => Promise.resolve([folder])) });
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

test('drops its subscription and layout on stop', async () => {
  const harness = fakeCore({ spaceSidebar: vi.fn(() => Promise.resolve([folder])) });
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
    spaceSidebar: vi.fn(
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
