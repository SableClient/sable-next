import { isTauri } from '@tauri-apps/api/core';
import { type as osType } from '@tauri-apps/plugin-os';

import { isNativeMobile } from './os.js';
import { hostsServiceWorker } from './service-worker.js';

/** Under Tauri the Rust side alerts through the OS, so a webview
    `new Notification()` would raise a second one beside it. */
export function presentsInApp(): boolean {
  return !isTauri() && typeof Notification !== 'undefined';
}

export function deliversWebPush(): boolean {
  return hostsServiceWorker() && 'PushManager' in globalThis;
}

/** Only a mobile build has a token distributor; `register_push` no-ops on
    desktop, which alerts from the running process instead. */
export async function deliversNativePush(): Promise<boolean> {
  if (!isTauri()) return false;
  const { type } = await import('@tauri-apps/plugin-os');
  const os = type();
  return os === 'android' || os === 'ios';
}

export function usesPushGateway(): boolean {
  return !isTauri() || isNativeMobile();
}

export type PushPlatform = 'web' | 'android' | 'ios' | 'desktop';

export function pushPlatform(): PushPlatform {
  if (!isTauri()) return 'web';
  const os = osType();
  return os === 'android' || os === 'ios' ? os : 'desktop';
}
