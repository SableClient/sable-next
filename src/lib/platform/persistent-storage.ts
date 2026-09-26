import { isTauri } from '@tauri-apps/api/core';

let requested: Promise<boolean> | undefined;

export function keepStorage(): Promise<boolean> {
  requested ??= request();
  return requested;
}

async function request(): Promise<boolean> {
  if (isTauri()) return true;
  const storage = globalThis.navigator.storage as StorageManager | undefined;
  if (storage?.persist === undefined) return false;
  try {
    if (await storage.persisted()) return true;
    return await storage.persist();
  } catch {
    return false;
  }
}
