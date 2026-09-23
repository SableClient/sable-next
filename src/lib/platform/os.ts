import { isTauri } from '@tauri-apps/api/core';
import { type as osType } from '@tauri-apps/plugin-os';

export function isNativeMobile(): boolean {
  if (!isTauri()) return false;
  const os = osType();
  return os === 'ios' || os === 'android';
}
