export class RoomPanels {
  threadRootId = $state<string | null>(null);
  threadsOpen = $state(false);
  attachmentsOpen = $state(false);
  searchOpen = $state(false);
  membersOpen = $state(false);
  desktopMembersOpen = $state(true);
  widgetsOpen = $state(false);

  reset(): void {
    this.threadRootId = null;
    this.threadsOpen = false;
    this.attachmentsOpen = false;
    this.searchOpen = false;
  }

  openThread(rootEventId: string): void {
    this.reset();
    this.widgetsOpen = false;
    this.membersOpen = false;
    this.threadRootId = rootEventId;
  }

  #closeAll(): void {
    this.reset();
    this.membersOpen = false;
    this.desktopMembersOpen = false;
    this.widgetsOpen = false;
  }

  toggleThreads(): void {
    const open = !this.threadsOpen;
    this.#closeAll();
    this.threadsOpen = open;
  }

  toggleAttachments(): void {
    const open = !this.attachmentsOpen;
    this.#closeAll();
    this.attachmentsOpen = open;
  }

  toggleSearch(): void {
    const open = !this.searchOpen;
    this.#closeAll();
    this.searchOpen = open;
  }

  toggleWidgets(): void {
    const open = !this.widgetsOpen;
    this.#closeAll();
    this.widgetsOpen = open;
  }

  toggleMembers(desktop: boolean): boolean {
    const open = !(desktop ? this.desktopMembersOpen : this.membersOpen);
    this.#closeAll();
    if (desktop) this.desktopMembersOpen = open;
    else this.membersOpen = open;
    return open;
  }

  closeMembers(desktop: boolean): void {
    if (desktop) this.desktopMembersOpen = false;
    else this.membersOpen = false;
  }
}
