import type { SidebarItemView } from '#src/generated/SidebarItemView';

export type SidebarItem = SidebarItemView;
export type SidebarFolder = Extract<SidebarItemView, { kind: 'folder' }>;

export type LayoutRef =
  | { kind: 'space'; roomId: string; folderId?: string }
  | { kind: 'folder'; folderId: string };

export type DropInstruction = 'above' | 'below' | 'into';

export const FOLDER_NAME_MAX_LENGTH = 200;

export function newFolderId(): string {
  return crypto.randomUUID();
}

export function isFolder(item: SidebarItem): item is SidebarFolder {
  return item.kind === 'folder';
}

export function refsEqual(left: LayoutRef, right: LayoutRef): boolean {
  if (left.kind === 'folder' || right.kind === 'folder') {
    return left.kind === 'folder' && right.kind === 'folder' && left.folderId === right.folderId;
  }

  return left.roomId === right.roomId && left.folderId === right.folderId;
}

export function mergeSpaces(
  items: readonly SidebarItem[],
  spaceIds: readonly string[]
): SidebarItem[] {
  const placed = new Set<string>();
  const merged: SidebarItem[] = [];

  for (const item of items) {
    if (item.kind === 'space') {
      if (placed.has(item.room_id)) continue;

      placed.add(item.room_id);
      merged.push(item);
      continue;
    }

    const content = item.content.filter((roomId) => !placed.has(roomId));
    if (content.length === 0) continue;

    for (const roomId of content) placed.add(roomId);
    merged.push({ ...item, content });
  }

  for (const roomId of spaceIds) {
    if (!placed.has(roomId)) merged.push({ kind: 'space', room_id: roomId });
  }

  return merged;
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
      item.content.length === other.content.length &&
      item.content.every((roomId, at) => roomId === other.content[at])
    );
  });
}

export function renameFolder(
  items: readonly SidebarItem[],
  folderId: string,
  name: string
): SidebarItem[] {
  const trimmed = name.trim();

  return items.map((item) =>
    item.kind === 'folder' && item.id === folderId
      ? { ...item, name: trimmed === '' ? null : trimmed }
      : item
  );
}

export function folderName(
  folder: SidebarFolder,
  spaceName: (roomId: string) => string | null
): string | null {
  if (folder.name !== null) return folder.name;

  const names = folder.content.map((roomId) => spaceName(roomId)).filter((name) => name !== null);

  return names.length === 0 ? null : names.join(', ');
}

export function ungroupFolder(items: readonly SidebarItem[], folderId: string): SidebarItem[] {
  return items.flatMap((item): SidebarItem[] => {
    if (!isFolder(item) || item.id !== folderId) return [item];

    return item.content.map((roomId) => ({ kind: 'space', room_id: roomId }));
  });
}

export function removeFromFolder(
  items: readonly SidebarItem[],
  roomId: string,
  folderId: string
): SidebarItem[] {
  return applyDrop(
    items,
    { kind: 'space', roomId, folderId },
    { kind: 'folder', folderId },
    'below'
  );
}

export function applyDrop(
  items: readonly SidebarItem[],
  source: LayoutRef,
  target: LayoutRef,
  instruction: DropInstruction,
  folderId: () => string = newFolderId
): SidebarItem[] {
  if (refsEqual(source, target)) return [...items];

  const dissolves = source.kind === 'folder' && (instruction === 'into' || inFolder(target));
  const sourceFolder = source.kind === 'folder' ? findFolder(items, source.folderId) : undefined;
  const moved = movedRooms(items, source, dissolves);
  const movedFolder = dissolves ? undefined : sourceFolder;
  if (moved.length === 0 && movedFolder === undefined) return [...items];

  const targetIndex = indexOfRef(items, target);
  const remaining = withoutRooms(withoutSource(items, source), moved);
  const insertion: SidebarItem[] =
    movedFolder === undefined
      ? moved.map((roomId) => ({ kind: 'space', room_id: roomId }))
      : [movedFolder];

  const at = indexOfRef(remaining, target);
  if (at === -1) return spliceAt(remaining, clamp(targetIndex, remaining.length), insertion);

  const entry = remaining[at];
  if (instruction === 'into') {
    return dropInto(remaining, at, entry, moved, sourceFolder, folderId);
  }

  const offset = instruction === 'below' ? 1 : 0;
  if (target.kind === 'space' && target.folderId !== undefined && entry.kind === 'folder') {
    const contentAt = entry.content.indexOf(target.roomId);
    if (contentAt !== -1) {
      return replaceAt(remaining, at, {
        ...entry,
        content: spliceAt(entry.content, contentAt + offset, moved),
      });
    }
  }

  return spliceAt(remaining, at + offset, insertion);
}

function inFolder(ref: LayoutRef): boolean {
  return ref.kind === 'space' && ref.folderId !== undefined;
}

function findFolder(items: readonly SidebarItem[], folderId: string): SidebarFolder | undefined {
  return items.find((item): item is SidebarFolder => isFolder(item) && item.id === folderId);
}

function movedRooms(
  items: readonly SidebarItem[],
  source: LayoutRef,
  dissolves: boolean
): string[] {
  if (source.kind === 'space') return [source.roomId];
  if (!dissolves) return [];

  return [...(findFolder(items, source.folderId)?.content ?? [])];
}

function withoutSource(items: readonly SidebarItem[], source: LayoutRef): SidebarItem[] {
  if (source.kind === 'folder') {
    return items.filter((item) => !(item.kind === 'folder' && item.id === source.folderId));
  }

  if (source.folderId === undefined) {
    return items.filter((item) => !(item.kind === 'space' && item.room_id === source.roomId));
  }

  return items.flatMap((item): SidebarItem[] => {
    if (!isFolder(item) || item.id !== source.folderId) return [item];

    const content = item.content.filter((roomId) => roomId !== source.roomId);

    return content.length === 0 ? [] : [{ ...item, content }];
  });
}

function withoutRooms(items: readonly SidebarItem[], rooms: readonly string[]): SidebarItem[] {
  if (rooms.length === 0) return [...items];

  const moving = new Set(rooms);

  return items.flatMap((item): SidebarItem[] => {
    if (item.kind === 'space') return moving.has(item.room_id) ? [] : [item];

    const content = item.content.filter((roomId) => !moving.has(roomId));

    return content.length === 0 ? [] : [{ ...item, content }];
  });
}

function dropInto(
  items: readonly SidebarItem[],
  at: number,
  entry: SidebarItem,
  moved: readonly string[],
  sourceFolder: SidebarFolder | undefined,
  folderId: () => string
): SidebarItem[] {
  if (entry.kind === 'folder') {
    return replaceAt(items, at, { ...entry, content: [...entry.content, ...moved] });
  }

  return replaceAt(items, at, {
    kind: 'folder',
    id: sourceFolder?.id ?? folderId(),
    name: sourceFolder?.name ?? null,
    content: [entry.room_id, ...moved],
  });
}

function indexOfRef(items: readonly SidebarItem[], ref: LayoutRef): number {
  return items.findIndex((item) => {
    if (ref.kind === 'folder') return item.kind === 'folder' && item.id === ref.folderId;
    if (ref.folderId !== undefined) return item.kind === 'folder' && item.id === ref.folderId;

    return item.kind === 'space' && item.room_id === ref.roomId;
  });
}

function clamp(index: number, length: number): number {
  return Math.max(0, Math.min(index, length));
}

function spliceAt<T>(items: readonly T[], at: number, inserted: readonly T[]): T[] {
  return [...items.slice(0, at), ...inserted, ...items.slice(at)];
}

function replaceAt<T>(items: readonly T[], at: number, replacement: T): T[] {
  return [...items.slice(0, at), replacement, ...items.slice(at + 1)];
}
