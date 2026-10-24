import type { ResolvedItem } from '#lib/rooms/timeline-item.js';
import { createContext } from 'svelte';

import type { EditVersionView } from '#src/generated/protocol';
import type { CursorAnchor } from '#lib/ui/cursor-anchor.js';

import type { MessageActions } from './message-menu-items';

export type MessageDialog =
  | { kind: 'source'; source: string; encrypted: boolean; original: string | null }
  | { kind: 'edit-history'; versions: readonly EditVersionView[]; senderTimezone: string | null }
  | { kind: 'delete'; target: string }
  | { kind: 'reactions'; active: number }
  | { kind: 'react'; anchor: HTMLElement | CursorAnchor | null }
  | { kind: 'sheet'; actions: () => MessageActions }
  | { kind: 'report' | 'forward' | 'steal' | 'reproxy' | 'receipts' };

export type OpenMessageDialog = MessageDialog & { key: number; item: ResolvedItem };

export class MessageDialogs {
  stack = $state.raw<readonly OpenMessageDialog[]>([]);
  #next = 0;

  open(item: ResolvedItem, dialog: MessageDialog): void {
    if (this.isOpen(item, dialog.kind)) return;
    this.stack = [...this.stack, { ...dialog, item, key: this.#next++ }];
  }

  close(key: number): void {
    this.stack = this.stack.filter((entry) => entry.key !== key);
  }

  isOpen(item: ResolvedItem, kind: MessageDialog['kind']): boolean {
    return this.stack.some((entry) => entry.item.id === item.id && entry.kind === kind);
  }
}

export const [useMessageDialogs, provideMessageDialogs] = createContext<MessageDialogs>();
