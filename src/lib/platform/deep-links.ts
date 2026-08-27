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

async function invokedLinks(command: string): Promise<string[]> {
  try {
    return (await invoke<string[] | null>(command)) ?? [];
  } catch {
    return [];
  }
}

export async function currentDeepLinks(): Promise<string[]> {
  if (!deliversDeepLinks()) return [];

  return [
    ...(await invokedLinks('plugin:deep-link|get_current')),
    ...(await invokedLinks('pending_deep_links')),
  ];
}
