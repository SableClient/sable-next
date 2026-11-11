import { createContext, untrack } from 'svelte';

import { readText, writeText } from '#lib/platform/local-json.js';

const membersStorageKey = 'sable-members-open';
let desktopMembersPreferred = readText(membersStorageKey) !== 'false';

function preferDesktopMembers(open: boolean): void {
  desktopMembersPreferred = open;
  writeText(membersStorageKey, String(open));
}

export type SidePanel =
  | 'threads'
  | 'attachments'
  | 'search'
  | 'notifications'
  | 'members'
  | 'desktopMembers'
  | 'widgets';

export class RoomPanels {
  threadRootId = $state<string | null>(null);
  side = $state<SidePanel | null>(desktopMembersPreferred ? 'desktopMembers' : null);
  swapped = $state(false);

  #show(panel: SidePanel | null): void {
    this.swapped = this.side !== null && panel !== null && this.side !== panel;
    this.side = panel;
  }

  #set(panel: SidePanel, open: boolean): void {
    if (open) this.#show(panel);
    else if (this.side === panel) this.#show(this.#home(panel));
  }

  #home(closing: SidePanel): SidePanel | null {
    return closing !== 'desktopMembers' && closing !== 'members' && desktopMembersPreferred
      ? 'desktopMembers'
      : null;
  }

  get threadsOpen(): boolean {
    return this.side === 'threads';
  }
  set threadsOpen(open: boolean) {
    this.#set('threads', open);
  }

  get attachmentsOpen(): boolean {
    return this.side === 'attachments';
  }
  set attachmentsOpen(open: boolean) {
    this.#set('attachments', open);
  }

  get searchOpen(): boolean {
    return this.side === 'search';
  }
  set searchOpen(open: boolean) {
    this.#set('search', open);
  }

  get notificationsOpen(): boolean {
    return this.side === 'notifications';
  }
  set notificationsOpen(open: boolean) {
    this.#set('notifications', open);
  }

  get membersOpen(): boolean {
    return this.side === 'members';
  }
  set membersOpen(open: boolean) {
    this.#set('members', open);
  }

  get desktopMembersOpen(): boolean {
    return this.side === 'desktopMembers';
  }
  set desktopMembersOpen(open: boolean) {
    this.#set('desktopMembers', open);
  }

  get widgetsOpen(): boolean {
    return this.side === 'widgets';
  }
  set widgetsOpen(open: boolean) {
    this.#set('widgets', open);
  }

  /** Called from a room-change effect, which must not come to depend on the open panel. */
  reset(): void {
    this.threadRootId = null;
    const side = untrack(() => this.side);
    if (side !== 'members' && side !== 'desktopMembers' && side !== 'widgets') {
      untrack(() => {
        this.#show(null);
      });
    }
  }

  openThread(rootEventId: string): void {
    this.swapped = this.side !== null || this.threadRootId !== null;
    this.threadRootId = rootEventId;
    if (this.side !== 'desktopMembers') this.side = null;
  }

  #toggle(panel: SidePanel): boolean {
    const open = this.side !== panel;
    const leavingThread = this.threadRootId !== null;
    this.threadRootId = null;
    this.#show(open ? panel : this.#home(panel));
    if (open && leavingThread) this.swapped = true;
    return open;
  }

  toggleThreads(): void {
    this.#toggle('threads');
  }

  toggleAttachments(): void {
    this.#toggle('attachments');
  }

  toggleSearch(): void {
    this.#toggle('search');
  }

  toggleNotifications(): void {
    this.#toggle('notifications');
  }

  toggleWidgets(): void {
    this.#toggle('widgets');
  }

  toggleMembers(desktop: boolean): boolean {
    const open = this.#toggle(desktop ? 'desktopMembers' : 'members');
    if (desktop) preferDesktopMembers(open);
    return open;
  }

  closeMembers(desktop: boolean): void {
    this.#set(desktop ? 'desktopMembers' : 'members', false);
    if (desktop) preferDesktopMembers(false);
  }
}

export class OpenRoomSearch {
  #open: (() => void) | null = null;

  register(open: () => void): () => void {
    this.#open = open;
    return () => {
      if (this.#open === open) this.#open = null;
    };
  }

  run(): boolean {
    if (!this.#open) return false;
    this.#open();
    return true;
  }
}

export const [useOpenRoomSearch, provideOpenRoomSearch] = createContext<OpenRoomSearch>();
