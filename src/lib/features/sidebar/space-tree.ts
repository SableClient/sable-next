import type { RoomListItemView, SpaceTreeNodeView } from '#src/generated/protocol';

export type ThreadKind = 'through' | 'branch' | 'last';

export type Thread = { level: number; kind: ThreadKind };

export type SpaceTreeRoom = {
  kind: 'room';
  room: RoomListItemView;
  roomId: string;
  parentSpaceId: string;
  depth: number;
  key: string;
  threads: Thread[];
};

export type SpaceTreeSpace = {
  kind: 'category' | 'link';
  room: RoomListItemView;
  depth: number;
  key: string;
  threads: Thread[];
  children: SpaceTreeNode[];
};

export type SpaceTreeNode = SpaceTreeRoom | SpaceTreeSpace;

export function spaceTreeNodes(
  nodes: readonly SpaceTreeNodeView[],
  parentSpaceId: string,
  byId: (roomId: string) => RoomListItemView | undefined
): SpaceTreeNode[] {
  return nodes.flatMap<SpaceTreeNode>((node) => {
    const room = byId(node.room_id);
    if (!room) return [];
    if (node.kind === 'room') {
      return [
        {
          kind: 'room',
          room,
          roomId: node.room_id,
          parentSpaceId,
          depth: node.depth,
          key: node.key,
          threads: [],
        },
      ];
    }
    const children =
      node.kind === 'category' ? spaceTreeNodes(node.children, parentSpaceId, byId) : [];
    return [{ kind: node.kind, room, depth: node.depth, key: node.key, threads: [], children }];
  });
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
