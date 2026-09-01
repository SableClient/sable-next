import { isTauri } from '@tauri-apps/api/core';

export function hostsServiceWorker(): boolean {
  return !isTauri() && typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

export async function registerServiceWorker(): Promise<void> {
  if (!hostsServiceWorker()) return;
  try {
    await navigator.serviceWorker.register('/service-worker.js', { type: 'module' });
  } catch (error) {
    console.debug('[sable] service worker registration failed', error);
  }
}
