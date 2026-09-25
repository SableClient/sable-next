import type { RoomSummary } from '#src/generated/protocol';

export type ThreadKind = 'through' | 'branch' | 'last';

export type Thread = { level: number; kind: ThreadKind };

export type SpaceTreeRoom = {
  kind: 'room';
  room: RoomSummary;
  roomId: string;
  parentSpaceId: string;
  depth: number;
  key: string;
  threads: Thread[];
};

export type SpaceTreeSpace = {
  kind: 'category' | 'link';
  room: RoomSummary;
  depth: number;
  key: string;
  threads: Thread[];
  children: SpaceTreeNode[];
};

export type SpaceTreeNode = SpaceTreeRoom | SpaceTreeSpace;

export function indentFor(parentDepth: number): number {
  return Math.max(0, parentDepth - 1);
}

export function spaceTree(
  root: RoomSummary,
  roomsById: ReadonlyMap<string, RoomSummary>,
  limit: number
): SpaceTreeNode[] {
  const holding = new Map<string, boolean>();

  function holdsRoom(space: RoomSummary, seen: Set<string>): boolean {
    const known = holding.get(space.room_id);
    if (known !== undefined) return known;
    if (seen.has(space.room_id)) return false;
    seen.add(space.room_id);

    const holds = space.space_children.some((edge) => {
      const child = roomsById.get(edge.room_id);
      if (!child) return false;
      return !child.is_space || holdsRoom(child, seen);
    });
    seen.delete(space.room_id);
    holding.set(space.room_id, holds);
    return holds;
  }

  function walk(space: RoomSummary, depth: number, ancestry: string[]): SpaceTreeNode[] {
    const indent = indentFor(depth);
    const nodes: SpaceTreeNode[] = [];

    for (const edge of space.space_children) {
      const room = roomsById.get(edge.room_id);
      if (!room || room.is_space) continue;

      nodes.push({
        kind: 'room',
        room,
        roomId: room.room_id,
        parentSpaceId: root.room_id,
        depth: indent,
        key: [...ancestry, room.room_id].join('/'),
        threads: [],
      });
    }

    for (const edge of space.space_children) {
      const room = roomsById.get(edge.room_id);
      if (!room?.is_space || ancestry.includes(room.room_id)) continue;
      if (!holdsRoom(room, new Set())) continue;

      const childDepth = depth + 1;
      const path = [...ancestry, room.room_id];
      const link = childDepth >= limit;
      nodes.push({
        kind: link ? 'link' : 'category',
        room,
        depth: indent,
        key: path.join('/'),
        threads: [],
        children: link ? [] : walk(room, childDepth, path),
      });
    }

    return nodes;
  }

  return walk(root, 0, [root.room_id]);
}

export interface FlattenOptions {
  closed: (key: string) => boolean;
  keep: (row: SpaceTreeRoom) => boolean;
}

export function flattenSpaceTree(
  nodes: readonly SpaceTreeNode[],
  options: FlattenOptions,
  parentDepth = 0
): SpaceTreeNode[] {
  const rows: SpaceTreeNode[] = [];

  function shown(list: readonly SpaceTreeNode[], hidden: boolean): SpaceTreeNode[] {
    if (!hidden) return [...list];

    return list.filter((node) => {
      if (node.kind === 'room') return options.keep(node);
      if (node.kind === 'link') return false;
      return shown(node.children, true).length > 0;
    });
  }

  function walk(
    list: readonly SpaceTreeNode[],
    depth: number,
    hidden: boolean,
    open: readonly number[]
  ): void {
    const visible = shown(list, hidden);
    const threaded = depth >= 2;
    const level = depth - 2;

    visible.forEach((node, index) => {
      const last = index === visible.length - 1;
      const threads: Thread[] = open.map((through) => ({ level: through, kind: 'through' }));
      if (threaded) threads.push({ level, kind: last ? 'last' : 'branch' });
      rows.push({ ...node, threads });

      if (node.kind !== 'category') return;
      walk(
        node.children,
        depth + 1,
        hidden || options.closed(node.key),
        threaded && !last ? [...open, level] : open
      );
    });
  }

  walk(nodes, parentDepth, false, []);
  return rows;
}
