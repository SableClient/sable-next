import { isTauri } from '@tauri-apps/api/core';

import { electronBridge } from './electron.js';
import { isNativeMobile } from './os.js';

export async function desktopDataDir(): Promise<string | null> {
  const electron = electronBridge();
  if (electron) return electron.dataDir();
  if (!isTauri() || isNativeMobile()) return null;
  const { appDataDir } = await import('@tauri-apps/api/path');
  return appDataDir();
}
