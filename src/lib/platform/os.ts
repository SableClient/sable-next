import { isTauri } from '@tauri-apps/api/core';
import { type as osType } from '@tauri-apps/plugin-os';

export function isNativeMobile(): boolean {
  if (!isTauri()) return false;
  const os = osType();
  return os === 'ios' || os === 'android';
}

export function isAndroid(): boolean {
  return isTauri() && osType() === 'android';
}

export function supportsKeyboardShortcuts(): boolean {
  if (isNativeMobile()) return false;
  return typeof matchMedia !== 'function' || matchMedia('(any-pointer: fine)').matches;
}

export function supportsTouch(): boolean {
  if (isNativeMobile()) return true;
  return typeof matchMedia === 'function' && matchMedia('(any-pointer: coarse)').matches;
}
