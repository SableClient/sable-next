import { isTauri } from '@tauri-apps/api/core';

/** Under Tauri the Rust side alerts through the OS, so a webview
    `new Notification()` would raise a second one beside it. */
export function presentsInApp(): boolean {
  return !isTauri() && typeof Notification !== 'undefined';
}

/** Tauri serves the app from `tauri://`, which has no service worker at all:
    `navigator.serviceWorker` is undefined there, not merely unsubscribed. */
export function deliversWebPush(): boolean {
  return (
    typeof navigator !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in globalThis
  );
}

/** Only a mobile build has a token distributor; `register_push` no-ops on
    desktop, which alerts from the running process instead. */
export async function deliversNativePush(): Promise<boolean> {
  if (!isTauri()) return false;
  const { type } = await import('@tauri-apps/plugin-os');
  const os = type();
  return os === 'android' || os === 'ios';
}
