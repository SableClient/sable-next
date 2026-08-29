import { isTauri } from '@tauri-apps/api/core';

export type BadgeStrategy = 'tauri-window' | 'web-app-badge' | 'none';

export function pickBadgeStrategy(
  runningInTauri: boolean,
  os: string,
  hasWebBadge: boolean
): BadgeStrategy {
  if (runningInTauri) return os === 'android' || os === 'ios' ? 'none' : 'tauri-window';
  return hasWebBadge ? 'web-app-badge' : 'none';
}

export async function setUnreadBadge(count: number): Promise<void> {
  const value = count > 0 ? count : null;

  if (!isTauri()) {
    if (pickBadgeStrategy(false, '', 'setAppBadge' in navigator) !== 'web-app-badge') return;
    if (value === null) await navigator.clearAppBadge();
    else await navigator.setAppBadge(value);
    return;
  }

  const { type } = await import('@tauri-apps/plugin-os');
  if (pickBadgeStrategy(true, type(), false) !== 'tauri-window') return;

  try {
    const { getCurrentWindow } = await import('@tauri-apps/api/window');
    await getCurrentWindow().setBadgeCount(value ?? undefined);
  } catch (error) {
    console.debug('[sable badge] setBadgeCount unsupported', error);
  }
}
