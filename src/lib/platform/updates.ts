import { isTauri } from '@tauri-apps/api/core';
import { type as osType } from '@tauri-apps/plugin-os';

export interface AvailableUpdate {
  version: string;
  notes: string | undefined;
  /** Downloads and stages the update; `relaunchApp` is what applies it. */
  install: (onProgress: (percent: number) => void) => Promise<void>;
}

export function supportsAutoUpdate(): boolean {
  if (!isTauri()) return false;
  const os = osType();
  return os !== 'android' && os !== 'ios';
}
let handle: { close: () => Promise<void> } | null = null;

export async function checkForUpdate(): Promise<AvailableUpdate | null> {
  if (!supportsAutoUpdate()) return null;

  const { check } = await import('@tauri-apps/plugin-updater');
  const update = await check();

  await handle?.close().catch((error: unknown) => {
    console.debug('[sable updates] releasing the previous update failed', error);
  });
  handle = update;
  if (!update) return null;

  return {
    version: update.version,
    notes: update.body,
    install: async (onProgress) => {
      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') {
          total = event.data.contentLength ?? 0;
        } else if (event.event === 'Progress') {
          downloaded += event.data.chunkLength;
          onProgress(total > 0 ? Math.min(Math.round((downloaded / total) * 100), 100) : 0);
        }
      });
      handle = null;
    },
  };
}

export async function relaunchApp(): Promise<void> {
  const { relaunch } = await import('@tauri-apps/plugin-process');
  await relaunch();
}
