// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';

import { FakeRuntime } from '#lib/test-support/fake-runtime.js';
import { toasts } from '#lib/ui/toasts.svelte.js';

import type { SidebarItem } from './sidebar-layout.js';
import { SpaceSidebar } from './sidebar-layout.svelte.js';

afterEach(() => {
  localStorage.clear();
  vi.restoreAllMocks();
});

const folder: SidebarItem = { kind: 'folder', id: 'f', name: 'Work', content: ['!a:example.org'] };
const lifted: SidebarItem[] = [{ kind: 'space', room_id: '!a:example.org' }];

async function started(items: SidebarItem[] = [], loaded = true) {
  const runtime = new FakeRuntime({ sidebar: { items, loaded } });
  const sidebar = new SpaceSidebar(() => runtime.client());
  await sidebar.start();
  return { runtime, sidebar };
}

test('shows the layout the slice serves and follows its patches', async () => {
  const { runtime, sidebar } = await started([folder]);
  expect(sidebar.items).toEqual([folder]);
  runtime.set('sidebar', { items: lifted, loaded: true });
  expect(sidebar.items).toEqual(lifted);
  sidebar.stop();
});

test('asks the slice to write a layout', async () => {
  const { runtime, sidebar } = await started();
  sidebar.write([folder]);
  await vi.waitFor(() => {
    expect(runtime.dispatched).toEqual([
      { target: { slice: 'sidebar', key: null }, action: { type: 'write', items: [folder] } },
    ]);
  });
  sidebar.stop();
});

test('tells the user when the core refused a layout', async () => {
  const { runtime, sidebar } = await started();
  const error = vi.spyOn(toasts, 'error').mockReturnValue(0);
  runtime.notice('sidebar', { type: 'save_failed' });
  runtime.notice('rooms', { type: 'save_failed' });
  expect(error).toHaveBeenCalledTimes(1);
  sidebar.stop();
});

test('toggles folders locally and persists rapid changes', async () => {
  localStorage.setItem('sable-open-space-folders', '["f"]');
  const { runtime, sidebar } = await started([folder]);
  expect(sidebar.openFolders.has('f')).toBe(true);
  sidebar.toggleFolder('f');
  expect(sidebar.openFolders.size).toBe(0);
  expect(localStorage.getItem('sable-open-space-folders')).toBe('[]');
  sidebar.toggleFolder('f');
  expect([...sidebar.openFolders]).toEqual(['f']);
  expect(localStorage.getItem('sable-open-space-folders')).toBe('["f"]');
  expect(runtime.dispatched).toEqual([]);
  sidebar.stop();
});

test('adopts synced open folders before the runtime is started', () => {
  const runtime = new FakeRuntime({ sidebar: { items: [], loaded: false } });
  const sidebar = new SpaceSidebar(() => runtime.client());
  sidebar.adoptOpenFolders(['f', 'g']);
  expect([...sidebar.openFolders]).toEqual(['f', 'g']);
  expect(localStorage.getItem('sable-open-space-folders')).toBe('["f","g"]');
  sidebar.adoptOpenFolders([]);
  expect(sidebar.openFolders.size).toBe(0);
  expect(localStorage.getItem('sable-open-space-folders')).toBe('[]');
  expect(runtime.dispatched).toEqual([]);
});

test('restores open folders from local storage after a snapshot is discarded', async () => {
  const first = await started([folder]);
  first.sidebar.toggleFolder('f');
  first.sidebar.stop();
  const again = await started([folder]);
  expect([...again.sidebar.openFolders]).toEqual(['f']);
  expect(localStorage.getItem('sable-open-space-folders')).toBe('["f"]');
  expect(again.runtime.dispatched).toEqual([]);
  again.sidebar.stop();
});

test('prunes missing folders only after the layout has loaded, including an empty layout', async () => {
  localStorage.setItem('sable-open-space-folders', '["f","gone"]');
  const { runtime, sidebar } = await started([], false);
  expect([...sidebar.openFolders]).toEqual(['f', 'gone']);
  runtime.set('sidebar', { items: [folder], loaded: true });
  expect([...sidebar.openFolders]).toEqual(['f']);
  expect(localStorage.getItem('sable-open-space-folders')).toBe('["f"]');
  runtime.set('sidebar', { items: [], loaded: true });
  expect(sidebar.openFolders.size).toBe(0);
  expect(localStorage.getItem('sable-open-space-folders')).toBe('[]');
  sidebar.stop();
});

test('drops its subscription and layout on stop', async () => {
  const { runtime, sidebar } = await started([folder]);
  sidebar.stop();
  await Promise.resolve();
  expect(sidebar.items).toEqual([]);
  expect(runtime.unsubscribed).toHaveLength(1);
});

test('a start that is stopped before the runtime answers subscribes to nothing', async () => {
  const runtime = new FakeRuntime({ sidebar: { items: [folder], loaded: true } });
  let release: (() => void) | undefined;
  const sidebar = new SpaceSidebar(async () => {
    await new Promise<void>((resolve) => {
      release = resolve;
    });
    return runtime.client();
  });
  const pending = sidebar.start();
  sidebar.stop();
  release?.();
  await pending;
  expect(sidebar.items).toEqual([]);
  expect(runtime.unsubscribed).toEqual([]);
});
