import { invoke, isTauri } from '@tauri-apps/api/core';

export interface SharedItem {
  kind: string;
  text?: string;
  fileName?: string;
  mime?: string;
}

export interface SharedBatch {
  batchId: string;
  items: SharedItem[];
}

export function receivesSharedContent(): boolean {
  return isTauri();
}

export async function drainSharedContent(): Promise<SharedBatch[]> {
  if (!receivesSharedContent()) return [];
  try {
    return await invoke<SharedBatch[]>('share_inbox_drain');
  } catch (error) {
    console.debug('[sable share-target] drain failed', error);
    return [];
  }
}

export async function readSharedFile(batchId: string, fileName: string): Promise<Uint8Array> {
  const bytes = await invoke<ArrayBuffer>('share_inbox_read', { batchId, fileName });
  return new Uint8Array(bytes);
}

export async function clearSharedBatch(batchId: string): Promise<void> {
  await invoke('share_inbox_clear', { batchId });
}
