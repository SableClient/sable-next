import { describe, expect, it } from 'vitest';

import {
  applyDrop,
  folderName,
  layoutSpaceIds,
  mergeSpaces,
  orderedKnownSpaceIds,
  rememberSpaceIds,
  removeFromFolder,
  renameFolder,
  ungroupFolder,
  withSpace,
  withoutSpace,
  type SidebarItem,
} from './sidebar-layout.js';

function space(roomId: string): SidebarItem {
  return { kind: 'space', room_id: roomId };
}

function folder(id: string, content: string[], name: string | null = null): SidebarItem {
  return { kind: 'folder', id, name, content };
}

const fixedId = (): string => 'new-folder';

describe('mergeSpaces', () => {
  it('keeps the stored order and appends unplaced spaces', () => {
    const merged = mergeSpaces([space('!b'), space('!a')], ['!a', '!b', '!c']);

    expect(merged).toEqual([space('!b'), space('!a'), space('!c')]);
  });

  it('removes spaces the room list does not consider active', () => {
    const merged = mergeSpaces([space('!a'), folder('f', ['!b', '!c'])], ['!a', '!c']);

    expect(merged).toEqual([space('!a'), folder('f', ['!c'])]);
  });

  it('places a duplicated space once', () => {
    const merged = mergeSpaces([space('!a'), folder('f', ['!a', '!b'])], ['!a', '!b']);

    expect(merged).toEqual([space('!a'), folder('f', ['!b'])]);
  });
});

describe('space order history', () => {
  it('keeps the first observed order when a room-list snapshot is reordered', () => {
    const known = rememberSpaceIds([], ['!alpha', '!beta', '!gamma']);

    expect(orderedKnownSpaceIds(known, ['!gamma', '!alpha', '!beta'])).toEqual([
      '!alpha',
      '!beta',
      '!gamma',
    ]);
  });

  it('remembers a temporarily absent space for a later snapshot', () => {
    const known = rememberSpaceIds(['!alpha', '!beta'], ['!alpha']);

    expect(orderedKnownSpaceIds(known, ['!beta', '!alpha'])).toEqual(['!alpha', '!beta']);
  });

  it('keeps an order set by dragging after a reordered snapshot', () => {
    const known = rememberSpaceIds([], ['!alpha', '!beta']);
    const dragged = applyDrop(
      mergeSpaces([], orderedKnownSpaceIds(known, ['!alpha', '!beta'])),
      { kind: 'space', room_id: '!beta', folder_id: null },
      { kind: 'space', room_id: '!alpha', folder_id: null },
      'above'
    );

    expect(mergeSpaces(dragged, orderedKnownSpaceIds(known, ['!beta', '!alpha']))).toEqual([
      space('!beta'),
      space('!alpha'),
    ]);
  });
});

describe('applyDrop', () => {
  it('makes a folder out of two spaces', () => {
    const items = [space('!a'), space('!b'), space('!c')];

    expect(
      applyDrop(
        items,
        { kind: 'space', room_id: '!c', folder_id: null },
        { kind: 'space', room_id: '!a', folder_id: null },
        'into',
        fixedId
      )
    ).toEqual([folder('new-folder', ['!a', '!c']), space('!b')]);
  });

  it('adds a space to an existing folder', () => {
    const items = [folder('f', ['!a']), space('!b')];

    expect(
      applyDrop(
        items,
        { kind: 'space', room_id: '!b', folder_id: null },
        { kind: 'folder', folder_id: 'f' },
        'into'
      )
    ).toEqual([folder('f', ['!a', '!b'])]);
  });

  it('reorders top-level spaces above and below', () => {
    const items = [space('!a'), space('!b'), space('!c')];

    expect(
      applyDrop(
        items,
        { kind: 'space', room_id: '!c', folder_id: null },
        { kind: 'space', room_id: '!a', folder_id: null },
        'above'
      )
    ).toEqual([space('!c'), space('!a'), space('!b')]);
    expect(
      applyDrop(
        items,
        { kind: 'space', room_id: '!a', folder_id: null },
        { kind: 'space', room_id: '!b', folder_id: null },
        'below'
      )
    ).toEqual([space('!b'), space('!a'), space('!c')]);
  });

  it('drops a space beside one inside an open folder', () => {
    const items = [folder('f', ['!a', '!b']), space('!c')];

    expect(
      applyDrop(
        items,
        { kind: 'space', room_id: '!c', folder_id: null },
        { kind: 'space', room_id: '!a', folder_id: 'f' },
        'below'
      )
    ).toEqual([folder('f', ['!a', '!c', '!b'])]);
  });

  it('reorders inside a folder', () => {
    const items = [folder('f', ['!a', '!b', '!c'])];

    expect(
      applyDrop(
        items,
        { kind: 'space', room_id: '!c', folder_id: 'f' },
        { kind: 'space', room_id: '!a', folder_id: 'f' },
        'above'
      )
    ).toEqual([folder('f', ['!c', '!a', '!b'])]);
  });

  it('takes a space out of its folder', () => {
    const items = [folder('f', ['!a', '!b']), space('!c')];

    expect(
      applyDrop(
        items,
        { kind: 'space', room_id: '!b', folder_id: 'f' },
        { kind: 'space', room_id: '!c', folder_id: null },
        'below'
      )
    ).toEqual([folder('f', ['!a']), space('!c'), space('!b')]);
  });

  it('keeps the position when emptying the folder it is dropped beside', () => {
    const items = [space('!a'), folder('f', ['!b']), space('!c')];

    expect(
      applyDrop(
        items,
        { kind: 'space', room_id: '!b', folder_id: 'f' },
        { kind: 'folder', folder_id: 'f' },
        'below'
      )
    ).toEqual([space('!a'), space('!b'), space('!c')]);
  });

  it('moves a folder as one entry when reordering', () => {
    const items = [space('!a'), folder('f', ['!b', '!c'])];

    expect(
      applyDrop(
        items,
        { kind: 'folder', folder_id: 'f' },
        { kind: 'space', room_id: '!a', folder_id: null },
        'above'
      )
    ).toEqual([folder('f', ['!b', '!c']), space('!a')]);
  });

  it('keeps a folder name when it is dropped onto a loose space', () => {
    const items = [space('!a'), folder('f', ['!b'], 'Work')];

    expect(
      applyDrop(
        items,
        { kind: 'folder', folder_id: 'f' },
        { kind: 'space', room_id: '!a', folder_id: null },
        'into'
      )
    ).toEqual([folder('f', ['!a', '!b'], 'Work')]);
  });

  it('reorders a folder below a space', () => {
    const items = [folder('f', ['!b']), space('!a')];

    expect(
      applyDrop(
        items,
        { kind: 'folder', folder_id: 'f' },
        { kind: 'space', room_id: '!a', folder_id: null },
        'below'
      )
    ).toEqual([space('!a'), folder('f', ['!b'])]);
  });

  it('lifts the last space out of a folder that sits last', () => {
    const items = [space('!a'), folder('f', ['!b'])];

    expect(removeFromFolder(items, '!b', 'f')).toEqual([space('!a'), space('!b')]);
  });

  it('merges one folder into another', () => {
    const items = [folder('f', ['!a']), folder('g', ['!b', '!c'])];

    expect(
      applyDrop(
        items,
        { kind: 'folder', folder_id: 'g' },
        { kind: 'folder', folder_id: 'f' },
        'into'
      )
    ).toEqual([folder('f', ['!a', '!b', '!c'])]);
  });

  it('dissolves a folder dropped beside a space inside another', () => {
    const items = [folder('f', ['!a']), folder('g', ['!b'])];

    expect(
      applyDrop(
        items,
        { kind: 'folder', folder_id: 'g' },
        { kind: 'space', room_id: '!a', folder_id: 'f' },
        'above'
      )
    ).toEqual([folder('f', ['!b', '!a'])]);
  });

  it('ignores a drop onto itself', () => {
    const items = [space('!a'), space('!b')];

    expect(
      applyDrop(
        items,
        { kind: 'space', room_id: '!a', folder_id: null },
        { kind: 'space', room_id: '!a', folder_id: null },
        'below'
      )
    ).toEqual(items);
  });
});

describe('removeFromFolder', () => {
  it('lifts a space out below its folder', () => {
    const items = [space('!a'), folder('f', ['!b', '!c'])];

    expect(removeFromFolder(items, '!b', 'f')).toEqual([
      space('!a'),
      folder('f', ['!c']),
      space('!b'),
    ]);
  });

  it('empties a folder holding a single space', () => {
    const items = [space('!a'), folder('f', ['!b']), space('!c')];

    expect(removeFromFolder(items, '!b', 'f')).toEqual([space('!a'), space('!b'), space('!c')]);
  });
});

describe('pinning a space', () => {
  it('lists every space the layout places, folders included', () => {
    expect(layoutSpaceIds([space('!a'), folder('f', ['!b', '!c'])])).toEqual(['!a', '!b', '!c']);
  });

  it('appends a pinned space once', () => {
    const items = [space('!a'), folder('f', ['!b'])];

    expect(withSpace(items, '!c')).toEqual([...items, space('!c')]);
    expect(withSpace(items, '!b')).toEqual(items);
  });

  it('unpins a space wherever it sits and drops a folder it emptied', () => {
    const items = [space('!a'), folder('f', ['!b']), folder('g', ['!b', '!c'])];

    expect(withoutSpace(items, '!b')).toEqual([space('!a'), folder('g', ['!c'])]);
    expect(withoutSpace(items, '!a')).toEqual(items.slice(1));
  });
});

describe('ungroupFolder', () => {
  it('restores the folder contents at its position', () => {
    const items = [space('!a'), folder('f', ['!b', '!c']), space('!d')];

    expect(ungroupFolder(items, 'f')).toEqual([space('!a'), space('!b'), space('!c'), space('!d')]);
  });

  it('leaves other folders alone', () => {
    const items = [folder('f', ['!a']), folder('g', ['!b'])];

    expect(ungroupFolder(items, 'g')).toEqual([folder('f', ['!a']), space('!b')]);
  });
});

describe('renameFolder', () => {
  it('sets and clears a name', () => {
    const items = [folder('f', ['!a'])];

    expect(renameFolder(items, 'f', '  Work  ')).toEqual([folder('f', ['!a'], 'Work')]);
    expect(renameFolder(renameFolder(items, 'f', 'Work'), 'f', '   ')).toEqual(items);
  });
});

describe('folderName', () => {
  const names: Record<string, string> = { '!a': 'Alpha', '!b': 'Beta' };
  const nameOf = (roomId: string): string | null => names[roomId] ?? null;

  it('prefers its own name', () => {
    expect(folderName({ kind: 'folder', id: 'f', name: 'Work', content: ['!a'] }, nameOf)).toBe(
      'Work'
    );
  });

  it('falls back to the spaces it holds', () => {
    expect(folderName({ kind: 'folder', id: 'f', name: null, content: ['!a', '!b'] }, nameOf)).toBe(
      'Alpha, Beta'
    );
  });

  it('has no name when nothing inside is named', () => {
    expect(folderName({ kind: 'folder', id: 'f', name: null, content: ['!z'] }, nameOf)).toBeNull();
  });
});
