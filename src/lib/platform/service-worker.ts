import { isTauri } from '@tauri-apps/api/core';

let registering: Promise<ServiceWorkerRegistration | undefined> | null = null;

export function hostsServiceWorker(): boolean {
  return !isTauri() && typeof navigator !== 'undefined' && 'serviceWorker' in navigator;
}

export function registerServiceWorker(): Promise<ServiceWorkerRegistration | undefined> {
  if (!hostsServiceWorker()) return Promise.resolve(undefined);

  registering ??= navigator.serviceWorker
    .register('/service-worker.js', { type: 'module' })
    .catch((error: unknown) => {
      console.debug('[sable] service worker registration failed', error);
      registering = null;
      return undefined;
    });

  return registering;
}

export async function activeServiceWorker(): Promise<ServiceWorkerRegistration | undefined> {
  if (!(await registerServiceWorker())) return undefined;
  return navigator.serviceWorker.ready;
}
