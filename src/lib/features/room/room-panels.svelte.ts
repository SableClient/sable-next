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
    this.threadRootId = rootEventId;
  }

  toggleThreads(): void {
    this.threadsOpen = !this.threadsOpen;
    this.attachmentsOpen = false;
    this.searchOpen = false;
  }

  toggleAttachments(): void {
    this.attachmentsOpen = !this.attachmentsOpen;
    this.threadsOpen = false;
    this.searchOpen = false;
  }

  toggleSearch(): void {
    this.searchOpen = !this.searchOpen;
    this.threadsOpen = false;
    this.attachmentsOpen = false;
    if (this.searchOpen) this.desktopMembersOpen = false;
  }

  toggleMembers(desktop: boolean): boolean {
    if (desktop) return (this.desktopMembersOpen = !this.desktopMembersOpen);
    return (this.membersOpen = !this.membersOpen);
  }

  closeMembers(desktop: boolean): void {
    if (desktop) this.desktopMembersOpen = false;
    else this.membersOpen = false;
  }
}
