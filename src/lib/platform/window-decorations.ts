import { isTauri } from '@tauri-apps/api/core';
import { type as osType } from '@tauri-apps/plugin-os';

export type WindowEdge =
  | 'North'
  | 'NorthEast'
  | 'East'
  | 'SouthEast'
  | 'South'
  | 'SouthWest'
  | 'West'
  | 'NorthWest';

export type TitleBarKind = 'desktop' | 'mac';

export interface DesktopWindowSettings {
  closeToTray: boolean;
  showSystemTrayIcon: boolean;
  useCustomTitleBar: boolean;
}

export interface DesktopWindowState {
  trayAvailable: boolean;
}

export function supportsDesktopWindow(): boolean {
  if (!isTauri()) return false;

  const os = osType();
  return os !== 'android' && os !== 'ios';
}

export function supportsTray(): boolean {
  return supportsDesktopWindow() && osType() !== 'macos';
}

export function customTitleBarDefault(): boolean {
  return supportsDesktopWindow() && osType() === 'windows';
}

export function titleBarKind(useCustomTitleBar: boolean): TitleBarKind | null {
  if (!useCustomTitleBar || !supportsDesktopWindow()) return null;

  return osType() === 'macos' ? 'mac' : 'desktop';
}

export async function applyDesktopWindowSettings(
  settings: DesktopWindowSettings
): Promise<DesktopWindowState | null> {
  if (!supportsDesktopWindow()) return null;

  const { invoke } = await import('@tauri-apps/api/core');
  return invoke<DesktopWindowState>('apply_desktop_window_settings', { settings });
}

async function currentWindow() {
  const { getCurrentWindow } = await import('@tauri-apps/api/window');
  return getCurrentWindow();
}

export async function minimizeWindow(): Promise<void> {
  await (await currentWindow()).minimize();
}

export async function toggleMaximizeWindow(): Promise<void> {
  await (await currentWindow()).toggleMaximize();
}

export async function closeWindow(): Promise<void> {
  await (await currentWindow()).close();
}

export async function startWindowDrag(): Promise<void> {
  await (await currentWindow()).startDragging();
}

export async function startWindowResize(edge: WindowEdge): Promise<void> {
  await (await currentWindow()).startResizeDragging(edge);
}

export async function watchMaximized(onChange: (maximized: boolean) => void): Promise<() => void> {
  const window = await currentWindow();
  onChange(await window.isMaximized());

  return window.onResized(() => {
    void window.isMaximized().then(onChange);
  });
}

export async function watchHiddenToTray(onHidden: () => void): Promise<() => void> {
  if (!supportsDesktopWindow()) return () => {};

  const { listen } = await import('@tauri-apps/api/event');
  return listen('window-hidden-to-tray', () => {
    onHidden();
  });
}
