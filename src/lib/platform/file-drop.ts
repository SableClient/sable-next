import { isTauri } from '@tauri-apps/api/core';

import { fileNameFromPath, mimeFromName } from './files.js';

export interface NativeFileDrop {
  onEnter: () => void;
  onLeave: () => void;
  onDrop: (files: File[]) => void;
}

export function listenNativeFileDrop(handlers: NativeFileDrop): () => void {
  if (!isTauri()) return () => {};

  let stopped = false;
  let unlisten: (() => void) | undefined;
  import('@tauri-apps/api/webview')
    .then(({ getCurrentWebview }) =>
      getCurrentWebview().onDragDropEvent(({ payload }) => {
        if (payload.type === 'enter') handlers.onEnter();
        else if (payload.type === 'leave') handlers.onLeave();
        else if (payload.type === 'drop') {
          handlers.onLeave();
          void readDroppedFiles(payload.paths).then(handlers.onDrop);
        }
      })
    )
    .then((stop) => {
      if (stopped) stop();
      else unlisten = stop;
    })
    .catch((error: unknown) => {
      console.debug('[sable files] native drop listener failed', error);
    });

  return () => {
    stopped = true;
    unlisten?.();
  };
}

export async function readDroppedFiles(paths: readonly string[]): Promise<File[]> {
  const { readFile } = await import('@tauri-apps/plugin-fs');
  const files = await Promise.all(
    paths.map(async (path, index) => {
      const name = fileNameFromPath(path, index);
      try {
        return new File([await readFile(path)], name, { type: mimeFromName(name) });
      } catch (error) {
        console.debug('[sable files] dropped file read failed', path, error);
        return null;
      }
    })
  );
  return files.filter((file): file is File => file !== null);
}
