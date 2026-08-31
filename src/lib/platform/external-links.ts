import { invoke, isTauri } from '@tauri-apps/api/core';

export function opensExternalUrls(): boolean {
  return isTauri();
}

export async function openExternalUrl(url: string): Promise<void> {
  await invoke('open_external_url', { url });
}
