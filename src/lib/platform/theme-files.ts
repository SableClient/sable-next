import { invoke, isTauri } from '@tauri-apps/api/core';

import { electronBridge } from './electron.js';
import type { ThemeFileSnapshot } from './file-dialog-types.js';
import { isNativeMobile } from './os.js';

export function watchesThemeFiles(): boolean {
  return electronBridge() !== undefined || (isTauri() && !isNativeMobile());
}

export async function pickThemeFiles(): Promise<ThemeFileSnapshot[]> {
  const electron = electronBridge();
  if (electron) return electron.pickThemeFiles();
  return invoke<ThemeFileSnapshot[]>('pick_theme_files');
}

export async function readThemeFile(
  path: string,
  since: number | null
): Promise<ThemeFileSnapshot | null> {
  const electron = electronBridge();
  if (electron) return electron.readThemeFile(path, since);
  return invoke<ThemeFileSnapshot | null>('read_theme_file', { path, since });
}
