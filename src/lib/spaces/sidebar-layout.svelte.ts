import { createContext } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';

import type { CoreClient } from '#lib/core/client.svelte.js';

import { isFolder, sameLayout, type SidebarItem } from './sidebar-layout.js';

const OPEN_FOLDERS_KEY = 'sable-open-space-folders';

function loadOpenFolders(): string[] {
  if (typeof localStorage === 'undefined') return [];

  try {
    const value: unknown = JSON.parse(localStorage.getItem(OPEN_FOLDERS_KEY) ?? '[]');

    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

export class SpaceSidebar {
  items = $state.raw<SidebarItem[]>([]);
  readonly openFolders = new SvelteSet<string>(loadOpenFolders());

  private core: CoreClient | null = null;
  private unsubscribeEvents: (() => void) | null = null;
  private generation = 0;
  private pending: { items: SidebarItem[]; stored: boolean } | null = null;

  async start(core: CoreClient): Promise<void> {
    const generation = ++this.generation;
    this.core = core;
    this.pending = null;

    this.unsubscribeEvents?.();
    this.unsubscribeEvents = core.subscribeEvents((event) => {
      if (event.type !== 'space_sidebar_changed' || generation !== this.generation) return;

      this.receive(event.items);
    });

    try {
      const items = await core.commands.spaceSidebar();
      if (generation === this.generation) this.setItems(items);
    } catch (error) {
      console.debug('[sable nav] space layout unavailable', error);
    }
  }

  stop(): void {
    this.generation += 1;
    this.core = null;
    this.items = [];
    this.pending = null;
    this.unsubscribeEvents?.();
    this.unsubscribeEvents = null;
  }

  write(items: SidebarItem[]): void {
    const core = this.core;
    if (core === null) return;

    const previous = this.items;
    const previousOpen = [...this.openFolders];
    const pending = { items, stored: false };
    this.pending = pending;
    this.setItems(items);

    void core.commands.setSpaceSidebar(items).then(
      () => {
        if (this.pending === pending) pending.stored = true;
      },
      (error: unknown) => {
        console.warn('[sable nav] space layout not saved', error);
        if (this.pending !== pending) return;

        this.pending = null;
        this.setItems(previous);
        for (const folderId of previousOpen) this.openFolders.add(folderId);
      }
    );
  }

  toggleFolder(folderId: string): void {
    if (this.openFolders.has(folderId)) {
      this.openFolders.delete(folderId);
    } else {
      this.openFolders.add(folderId);
    }

    this.persistOpenFolders();
  }

  private receive(items: SidebarItem[]): void {
    const pending = this.pending;
    if (pending !== null) {
      if (!pending.stored && !sameLayout(items, pending.items)) return;

      this.pending = null;
    }

    this.setItems(items);
  }

  private setItems(items: SidebarItem[]): void {
    this.items = items;

    // eslint-disable-next-line svelte/prefer-svelte-reactivity
    const folderIds = new Set(items.filter(isFolder).map((folder) => folder.id));
    let pruned = false;
    for (const folderId of this.openFolders) {
      if (folderIds.has(folderId)) continue;

      this.openFolders.delete(folderId);
      pruned = true;
    }
    if (pruned) this.persistOpenFolders();
  }

  adoptOpenFolders(ids: readonly string[]): void {
    this.openFolders.clear();
    for (const id of ids) this.openFolders.add(id);
    this.persistOpenFolders();
  }

  private persistOpenFolders(): void {
    if (typeof localStorage === 'undefined') return;

    try {
      localStorage.setItem(OPEN_FOLDERS_KEY, JSON.stringify([...this.openFolders]));
    } catch (error) {
      console.debug('[sable nav] open folders not persisted', error);
    }
  }
}

export const [useSpaceSidebar, provideSpaceSidebar] = createContext<SpaceSidebar>();
