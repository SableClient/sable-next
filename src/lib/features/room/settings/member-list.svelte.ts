export const MEMBER_LIST_EVENT_TYPE = 'moe.sable.room.member_list';

export const memberListChanges = $state({ version: 0 });

export function memberListChanged(): void {
  memberListChanges.version += 1;
}
