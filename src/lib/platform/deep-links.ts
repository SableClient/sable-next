import { invoke, isTauri } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export function deliversDeepLinks(): boolean {
  return isTauri();
}

export async function subscribeDeepLinks(onUrls: (urls: string[]) => void): Promise<() => void> {
  if (!deliversDeepLinks()) return () => {};

  try {
    return await listen<string[]>('deep-link://new-url', (event) => {
      onUrls(event.payload);
    });
  } catch {
    return () => {};
  }
}

export async function currentDeepLinks(): Promise<string[]> {
  if (!deliversDeepLinks()) return [];

  const urls: string[] = [];
  try {
    urls.push(...((await invoke<string[] | null>('plugin:deep-link|get_current')) ?? []));
  } catch {}
  try {
    urls.push(...(await invoke<string[]>('pending_deep_links')));
  } catch {}
  return urls;
}
