import { isTauri } from '@tauri-apps/api/core';

export function transfersRoomKeys(): boolean {
  return isTauri();
}
