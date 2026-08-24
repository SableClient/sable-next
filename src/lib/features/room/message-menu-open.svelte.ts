class OpenMessageMenu {
  id = $state<string | null>(null);

  isOpen(rowId: string): boolean {
    return this.id === rowId;
  }

  set(rowId: string, open: boolean): void {
    if (open) this.id = rowId;
    else if (this.id === rowId) this.id = null;
  }
}

export const openMessageMenu = new OpenMessageMenu();
