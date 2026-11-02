import { isTauri } from '@tauri-apps/api/core';
import { type as osType } from '@tauri-apps/plugin-os';

import { isElectron } from './electron.js';
import { isNativeMobile } from './os.js';
import { hostsServiceWorker } from './service-worker.js';

/** The mobile shell raises its own native notifications, so a webview
    `new Notification()` would raise a second one beside it. */
export function presentsInApp(): boolean {
  return !isTauri() && typeof Notification !== 'undefined';
}

/** Electron ships no push service, so `pushManager.subscribe()` always
    rejects there (electron/electron#6697). */
export function deliversWebPush(): boolean {
  return !isElectron() && hostsServiceWorker() && 'PushManager' in globalThis;
}

/** Only the mobile shell has a token distributor. */
export function deliversNativePush(): boolean {
  return isNativeMobile();
}

export type PushPlatform = 'web' | 'android' | 'ios' | 'desktop';

export function pushPlatform(): PushPlatform {
  if (isElectron()) return 'desktop';
  if (!isNativeMobile()) return 'web';
  return osType() === 'ios' ? 'ios' : 'android';
}
