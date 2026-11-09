import type { DropInstruction, LayoutRef, SidebarItemView } from '#src/generated/protocol';

import { applyLayoutDrop } from '#lib/model/model.js';

export {
  layoutSpaceIds,
  mergeSpaces,
  orderedKnownSpaceIds,
  rememberSpaceIds,
  removeFromFolder,
  renameFolder,
  setFolderIcon,
  ungroupFolder,
  withoutSpace,
  withSpace,
} from '#lib/model/model.js';

export type SidebarItem = SidebarItemView;
export type SidebarFolder = Extract<SidebarItemView, { kind: 'folder' }>;

export type { DropInstruction, LayoutRef };

export const FOLDER_NAME_MAX_LENGTH = 200;

export function newFolderId(): string {
  return crypto.randomUUID();
}

export function isFolder(item: SidebarItem): item is SidebarFolder {
  return item.kind === 'folder';
}

export function refsEqual(left: LayoutRef, right: LayoutRef): boolean {
  if (left.kind === 'folder' || right.kind === 'folder') {
    return left.kind === 'folder' && right.kind === 'folder' && left.folder_id === right.folder_id;
  }

  return left.room_id === right.room_id && left.folder_id === right.folder_id;
}

export function sameLayout(left: readonly SidebarItem[], right: readonly SidebarItem[]): boolean {
  if (left.length !== right.length) return false;

  return left.every((item, index) => {
    const other = right[index];
    if (item.kind !== other.kind) return false;
    if (item.kind === 'space') return other.kind === 'space' && item.room_id === other.room_id;
    if (other.kind !== 'folder') return false;

    return (
      item.id === other.id &&
      item.name === other.name &&
      item.icon === other.icon &&
      item.content.length === other.content.length &&
      item.content.every((roomId, at) => roomId === other.content[at])
    );
  });
}

export function folderName(
  folder: SidebarFolder,
  spaceName: (roomId: string) => string | null
): string | null {
  if (folder.name !== null) return folder.name;

  const names = folder.content.map((roomId) => spaceName(roomId)).filter((name) => name !== null);

  return names.length === 0 ? null : names.join(', ');
}

export function applyDrop(
  items: readonly SidebarItem[],
  source: LayoutRef,
  target: LayoutRef,
  instruction: DropInstruction,
  folderId: () => string = newFolderId
): SidebarItem[] {
  return applyLayoutDrop(items, source, target, instruction, folderId());
}
