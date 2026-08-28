import { describe, expect, it } from 'vitest';

import {
  applyDrop,
  sameLayout,
  folderName,
  mergeSpaces,
  removeFromFolder,
  renameFolder,
  ungroupFolder,
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

describe('applyDrop', () => {
  it('makes a folder out of two spaces', () => {
    const items = [space('!a'), space('!b'), space('!c')];

    expect(
      applyDrop(
        items,
        { kind: 'space', roomId: '!c' },
        { kind: 'space', roomId: '!a' },
        'into',
        fixedId
      )
    ).toEqual([folder('new-folder', ['!a', '!c']), space('!b')]);
  });

  it('adds a space to an existing folder', () => {
    const items = [folder('f', ['!a']), space('!b')];

    expect(
      applyDrop(items, { kind: 'space', roomId: '!b' }, { kind: 'folder', folderId: 'f' }, 'into')
    ).toEqual([folder('f', ['!a', '!b'])]);
  });

  it('reorders top-level spaces above and below', () => {
    const items = [space('!a'), space('!b'), space('!c')];

    expect(
      applyDrop(items, { kind: 'space', roomId: '!c' }, { kind: 'space', roomId: '!a' }, 'above')
    ).toEqual([space('!c'), space('!a'), space('!b')]);
    expect(
      applyDrop(items, { kind: 'space', roomId: '!a' }, { kind: 'space', roomId: '!b' }, 'below')
    ).toEqual([space('!b'), space('!a'), space('!c')]);
  });

  it('drops a space beside one inside an open folder', () => {
    const items = [folder('f', ['!a', '!b']), space('!c')];

    expect(
      applyDrop(
        items,
        { kind: 'space', roomId: '!c' },
        { kind: 'space', roomId: '!a', folderId: 'f' },
        'below'
      )
    ).toEqual([folder('f', ['!a', '!c', '!b'])]);
  });

  it('reorders inside a folder', () => {
    const items = [folder('f', ['!a', '!b', '!c'])];

    expect(
      applyDrop(
        items,
        { kind: 'space', roomId: '!c', folderId: 'f' },
        { kind: 'space', roomId: '!a', folderId: 'f' },
        'above'
      )
    ).toEqual([folder('f', ['!c', '!a', '!b'])]);
  });

  it('takes a space out of its folder', () => {
    const items = [folder('f', ['!a', '!b']), space('!c')];

    expect(
      applyDrop(
        items,
        { kind: 'space', roomId: '!b', folderId: 'f' },
        { kind: 'space', roomId: '!c' },
        'below'
      )
    ).toEqual([folder('f', ['!a']), space('!c'), space('!b')]);
  });

  it('keeps the position when emptying the folder it is dropped beside', () => {
    const items = [space('!a'), folder('f', ['!b']), space('!c')];

    expect(
      applyDrop(
        items,
        { kind: 'space', roomId: '!b', folderId: 'f' },
        { kind: 'folder', folderId: 'f' },
        'below'
      )
    ).toEqual([space('!a'), space('!b'), space('!c')]);
  });

  it('moves a folder as one entry when reordering', () => {
    const items = [space('!a'), folder('f', ['!b', '!c'])];

    expect(
      applyDrop(items, { kind: 'folder', folderId: 'f' }, { kind: 'space', roomId: '!a' }, 'above')
    ).toEqual([folder('f', ['!b', '!c']), space('!a')]);
  });

  it('keeps a folder name when it is dropped onto a loose space', () => {
    const items = [space('!a'), folder('f', ['!b'], 'Work')];

    expect(
      applyDrop(items, { kind: 'folder', folderId: 'f' }, { kind: 'space', roomId: '!a' }, 'into')
    ).toEqual([folder('f', ['!a', '!b'], 'Work')]);
  });

  it('reorders a folder below a space', () => {
    const items = [folder('f', ['!b']), space('!a')];

    expect(
      applyDrop(items, { kind: 'folder', folderId: 'f' }, { kind: 'space', roomId: '!a' }, 'below')
    ).toEqual([space('!a'), folder('f', ['!b'])]);
  });

  it('lifts the last space out of a folder that sits last', () => {
    const items = [space('!a'), folder('f', ['!b'])];

    expect(removeFromFolder(items, '!b', 'f')).toEqual([space('!a'), space('!b')]);
  });

  it('merges one folder into another', () => {
    const items = [folder('f', ['!a']), folder('g', ['!b', '!c'])];

    expect(
      applyDrop(items, { kind: 'folder', folderId: 'g' }, { kind: 'folder', folderId: 'f' }, 'into')
    ).toEqual([folder('f', ['!a', '!b', '!c'])]);
  });

  it('dissolves a folder dropped beside a space inside another', () => {
    const items = [folder('f', ['!a']), folder('g', ['!b'])];

    expect(
      applyDrop(
        items,
        { kind: 'folder', folderId: 'g' },
        { kind: 'space', roomId: '!a', folderId: 'f' },
        'above'
      )
    ).toEqual([folder('f', ['!b', '!a'])]);
  });

  it('ignores a drop onto itself', () => {
    const items = [space('!a'), space('!b')];

    expect(
      applyDrop(items, { kind: 'space', roomId: '!a' }, { kind: 'space', roomId: '!a' }, 'below')
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

describe('sameLayout', () => {
  it('sees a difference in a folder name, in order and in kind', () => {
    expect(sameLayout([folder('f', ['!a'])], [folder('f', ['!a'])])).toBe(true);
    expect(sameLayout([folder('f', ['!a'], 'Work')], [folder('f', ['!a'])])).toBe(false);
    expect(sameLayout([folder('f', ['!a', '!b'])], [folder('f', ['!b', '!a'])])).toBe(false);
    expect(sameLayout([space('!a'), folder('f', ['!b'])], [folder('f', ['!b']), space('!a')])).toBe(
      false
    );
    expect(sameLayout([space('!a')], [space('!a'), space('!b')])).toBe(false);
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
