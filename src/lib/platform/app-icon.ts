import { invoke } from '@tauri-apps/api/core';

import { isNativeMobile } from './os';

export type AppIcons = { available: string[]; current: string | null };

export async function loadAppIcons(): Promise<AppIcons | null> {
  if (!isNativeMobile()) return null;
  try {
    const [available, current] = await Promise.all([
      invoke<string[]>('plugin:app-icon|get_available_icons'),
      invoke<string | null>('plugin:app-icon|get_current_icon'),
    ]);
    return { available, current };
  } catch {
    return null;
  }
}

export async function setAppIcon(icon: string | null): Promise<void> {
  await invoke('plugin:app-icon|set_icon', { request: { icon } });
}
