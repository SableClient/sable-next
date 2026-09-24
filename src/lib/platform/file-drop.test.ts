import { beforeEach, expect, test, vi } from 'vitest';

import { listenNativeFileDrop, readDroppedFiles } from './file-drop';

type DragPayload =
  | { type: 'enter'; paths: string[] }
  | { type: 'over' }
  | { type: 'drop'; paths: string[] }
  | { type: 'leave' };

const mocks = vi.hoisted(() => ({
  isTauri: vi.fn(),
  fsReadFile: vi.fn(),
  onDragDropEvent: vi.fn(),
  unlisten: vi.fn(),
}));

vi.mock('@tauri-apps/api/core', () => ({ isTauri: mocks.isTauri }));
vi.mock('@tauri-apps/plugin-fs', () => ({ readFile: mocks.fsReadFile }));
vi.mock('@tauri-apps/api/webview', () => ({
  getCurrentWebview: () => ({ onDragDropEvent: mocks.onDragDropEvent }),
}));

let emit: (payload: DragPayload) => void = () => {};

beforeEach(() => {
  mocks.isTauri.mockReturnValue(true);
  mocks.fsReadFile.mockReset();
  mocks.unlisten.mockReset();
  mocks.onDragDropEvent.mockReset().mockImplementation((handler: (event: object) => void) => {
    emit = (payload) => {
      handler({ payload });
    };
    return Promise.resolve(mocks.unlisten);
  });
});

function handlers() {
  return { onEnter: vi.fn(), onLeave: vi.fn(), onDrop: vi.fn() };
}

test('a native drop is read into files and staged', async () => {
  mocks.fsReadFile.mockResolvedValue(new Uint8Array([104, 105]));
  const drop = handlers();
  listenNativeFileDrop(drop);
  await vi.waitFor(() => {
    expect(mocks.onDragDropEvent).toHaveBeenCalled();
  });

  emit({ type: 'enter', paths: ['/home/me/cat.png'] });
  expect(drop.onEnter).toHaveBeenCalledOnce();

  emit({ type: 'drop', paths: ['/home/me/cat.png'] });
  expect(drop.onLeave).toHaveBeenCalledOnce();
  await vi.waitFor(() => {
    expect(drop.onDrop).toHaveBeenCalledOnce();
  });

  const [files] = drop.onDrop.mock.calls[0] as [File[]];
  expect(files).toHaveLength(1);
  expect(files[0].name).toBe('cat.png');
  expect(files[0].type).toBe('image/png');
  expect(files[0].size).toBe(2);
  expect(mocks.fsReadFile).toHaveBeenCalledWith('/home/me/cat.png');
});

test('a leave clears the overlay without staging', async () => {
  const drop = handlers();
  listenNativeFileDrop(drop);
  await vi.waitFor(() => {
    expect(mocks.onDragDropEvent).toHaveBeenCalled();
  });

  emit({ type: 'enter', paths: ['/tmp/a.txt'] });
  emit({ type: 'over' });
  emit({ type: 'leave' });

  expect(drop.onLeave).toHaveBeenCalledOnce();
  expect(drop.onDrop).not.toHaveBeenCalled();
});

test('outside Tauri nothing is listened to', () => {
  mocks.isTauri.mockReturnValue(false);
  listenNativeFileDrop(handlers())();
  expect(mocks.onDragDropEvent).not.toHaveBeenCalled();
});

test('stopping before the listener lands still unlistens', async () => {
  listenNativeFileDrop(handlers())();
  await vi.waitFor(() => {
    expect(mocks.unlisten).toHaveBeenCalledOnce();
  });
});

test('a path that cannot be read, such as a folder, is skipped', async () => {
  mocks.fsReadFile
    .mockRejectedValueOnce(new Error('is a directory'))
    .mockResolvedValueOnce(new Uint8Array([1]));

  const files = await readDroppedFiles(['/home/me/photos', '/home/me/notes.txt']);

  expect(files.map((file) => file.name)).toEqual(['notes.txt']);
});
