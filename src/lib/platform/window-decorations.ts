import { electronBridge, isElectron } from './electron';

export type TitleBarKind = 'desktop' | 'mac';

export interface DesktopWindowSettings {
  closeToTray: boolean;
  minimizeToTray: boolean;
  showSystemTrayIcon: boolean;
  useCustomTitleBar: boolean;
  smoothScrolling: boolean;
}

export interface DesktopWindowState {
  trayAvailable: boolean;
}

export function supportsCustomTitleBar(): boolean {
  return isElectron();
}

function desktopOs(): 'macos' | 'windows' | 'linux' | null {
  const platform = electronBridge()?.platform;
  if (platform === undefined) return null;
  return platform === 'darwin' ? 'macos' : platform === 'win32' ? 'windows' : 'linux';
}

export function supportsTray(): boolean {
  const platform = electronBridge()?.platform;
  return platform === 'linux' || platform === 'freebsd' || platform === 'win32';
}

export function supportsSmoothScrollingToggle(): boolean {
  return isElectron();
}

export function customTitleBarDefault(): boolean {
  return desktopOs() === 'windows';
}

export function hardwareVideoEncodeDefault(): boolean {
  return desktopOs() !== 'linux';
}

export function titleBarKind(useCustomTitleBar: boolean): TitleBarKind | null {
  if (!useCustomTitleBar || !supportsCustomTitleBar()) return null;

  return desktopOs() === 'macos' ? 'mac' : 'desktop';
}

export function applyDesktopWindowSettings(
  settings: DesktopWindowSettings
): Promise<DesktopWindowState | null> {
  return electronBridge()?.applyWindowSettings(settings) ?? Promise.resolve(null);
}

export function minimizeWindow(): void {
  electronBridge()?.minimizeWindow();
}

export function toggleMaximizeWindow(): void {
  electronBridge()?.toggleMaximizeWindow();
}

export function closeWindow(): void {
  electronBridge()?.closeWindow();
}

export async function watchMaximized(onChange: (maximized: boolean) => void): Promise<() => void> {
  const electron = electronBridge();
  if (!electron) return () => {};
  const stop = electron.onWindowMaximized(onChange);
  onChange(await electron.isWindowMaximized());
  return stop;
}

export function watchHiddenToTray(onHidden: () => void): () => void {
  return electronBridge()?.onWindowHiddenToTray(onHidden) ?? (() => {});
}
