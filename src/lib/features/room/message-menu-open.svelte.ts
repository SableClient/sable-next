import type { MessageActions } from './message-menu-items';

export interface MenuPoint {
  readonly x: number;
  readonly y: number;
}

class OpenMessageMenu {
  id = $state<string | null>(null);
  point = $state.raw<MenuPoint>({ x: 0, y: 0 });
  actions = $state.raw<(() => MessageActions) | null>(null);

  isOpen(rowId: string): boolean {
    return this.id === rowId;
  }

  set(rowId: string, open: boolean): void {
    if (open) this.id = rowId;
    else if (this.id === rowId) this.id = null;
  }

  open(rowId: string, point: MenuPoint, actions: () => MessageActions): void {
    this.actions = actions;
    this.point = point;
    this.id = rowId;
  }

  close(): void {
    this.id = null;
  }
}

export const openMessageMenu = new OpenMessageMenu();
