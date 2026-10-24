import { createContext } from 'svelte';
import { SvelteSet } from 'svelte/reactivity';

import type { SidebarAction } from '#src/generated/protocol';

import { t } from '#lib/i18n.js';
import { readJson, writeJson } from '#lib/platform/local-json.js';
import { runtime } from '#lib/runtime/app.js';
import type { Client } from '#lib/runtime/client.js';
import { SliceHandle } from '#lib/runtime/handle.svelte.js';
import { toasts } from '#lib/ui/toasts.svelte.js';

import { isFolder, type SidebarItem } from './sidebar-layout.js';

const OPEN_FOLDERS_KEY = 'sable-open-space-folders';
const NO_ITEMS: SidebarItem[] = [];

function loadOpenFolders(): string[] {
  return readJson(
    OPEN_FOLDERS_KEY,
    (value) =>
      Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : [],
    []
  );
}

export class SpaceSidebar {
  private readonly handle: SliceHandle<'sidebar'>;
  readonly openFolders = new SvelteSet<string>(loadOpenFolders());

  constructor(connect: () => Promise<Client> = runtime) {
    this.handle = new SliceHandle('sidebar', null, connect, {
      onChange: () => {
        if (this.handle.view?.loaded) this.pruneOpenFolders();
      },
      onNotice: () => {
        toasts.error(t('errors.actionFailed'));
      },
    });
  }

  get items(): SidebarItem[] {
    return this.handle.view?.items ?? NO_ITEMS;
  }

  async start(): Promise<void> {
    await this.handle.open();
  }

  stop(): void {
    this.handle.close();
  }

  write(items: SidebarItem[]): void {
    this.send({ type: 'write', items });
  }

  toggleFolder(folderId: string): void {
    if (this.openFolders.has(folderId)) this.openFolders.delete(folderId);
    else this.openFolders.add(folderId);
    this.persistOpenFolders();
  }

  adoptOpenFolders(ids: readonly string[]): void {
    this.openFolders.clear();
    for (const id of ids) this.openFolders.add(id);
    this.persistOpenFolders();
  }

  private send(action: SidebarAction): void {
    this.handle.dispatch(action).catch((error: unknown) => {
      console.warn('[sable nav] space layout not sent', error);
    });
  }

  private pruneOpenFolders(): void {
    // eslint-disable-next-line svelte/prefer-svelte-reactivity -- only used during this update
    const folders = new Set(this.items.filter(isFolder).map((folder) => folder.id));
    let pruned = false;
    for (const id of this.openFolders) {
      if (folders.has(id)) continue;
      this.openFolders.delete(id);
      pruned = true;
    }
    if (pruned) this.persistOpenFolders();
  }

  private persistOpenFolders(): void {
    writeJson(OPEN_FOLDERS_KEY, [...this.openFolders], '[sable nav] open folders not persisted');
  }
}

export const [useSpaceSidebar, provideSpaceSidebar] = createContext<SpaceSidebar>();
