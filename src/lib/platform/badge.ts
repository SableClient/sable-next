import { invoke, isTauri } from '@tauri-apps/api/core';

export type BadgeStrategy = 'tauri-window' | 'tauri-tray' | 'web-app-badge' | 'none';

export function pickBadgeStrategy(
  runningInTauri: boolean,
  os: string,
  hasWebBadge: boolean
): BadgeStrategy {
  if (runningInTauri) {
    if (os === 'android' || os === 'ios') return 'none';
    return os === 'linux' ? 'tauri-tray' : 'tauri-window';
  }
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
  const strategy = pickBadgeStrategy(true, type(), false);

  try {
    if (strategy === 'tauri-tray') {
      await invoke('set_tray_unread', { unread: value !== null });
    } else if (strategy === 'tauri-window') {
      const { getCurrentWindow } = await import('@tauri-apps/api/window');
      await getCurrentWindow().setBadgeCount(value ?? undefined);
    }
  } catch (error) {
    console.debug('[sable badge] badge not updated', error);
  }
}
