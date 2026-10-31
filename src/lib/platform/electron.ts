import type { UpdateChannel, WebRtcIpPolicy } from '#lib/settings/preferences.svelte.js';
import type { PickedFile, PickFilesRequest, SaveFileRequest } from './file-dialog-types';
import type { ScreenAudioChoice } from './screen-audio-stream';
import type { ScreenAudioListing } from './screen-audio-types';
import type { DesktopWindowSettings, DesktopWindowState } from './window-decorations';

export interface ElectronSettings {
  hardwareAcceleration: boolean;
  hardwareVideoAcceleration: boolean;
  smoothScrolling: boolean;
  webRtcIpPolicy: WebRtcIpPolicy;
  updateChannel: UpdateChannel;
  launchAtLogin: boolean;
  startMinimized: boolean;
}

export interface ScreenShareCandidate {
  id: string;
  name: string;
  thumbnail: string;
}

export interface ElectronBridge {
  platform: string;
  screenAudioAvailable: boolean;
  autostartAvailable: boolean;
  setBadge(count: number, overlay: string | null): Promise<void>;
  requestAttention(): void;
  clearWebCaches(): Promise<void>;
  applyWindowSettings(settings: DesktopWindowSettings): Promise<DesktopWindowState | null>;
  minimizeWindow(): void;
  showWindow(): void;
  toggleMaximizeWindow(): void;
  closeWindow(): void;
  isWindowMaximized(): Promise<boolean>;
  onWindowMaximized(callback: (maximized: boolean) => void): () => void;
  onWindowHiddenToTray(callback: () => void): () => void;
  applySettings(settings: ElectronSettings): void;
  setTelemetryConsent(enabled: boolean): void;
  takeDeepLinks(): Promise<string[]>;
  openAuthWindow(id: string, url: string, callbackUri?: string): Promise<void>;
  closeAuthWindow(id: string): Promise<void>;
  openAuthInSystemBrowser(url: string): Promise<void>;
  onDeepLinks(callback: (urls: string[]) => void): () => void;
  screenAudioApps(): Promise<ScreenAudioListing>;
  startScreenAudio(selection: Exclude<ScreenAudioChoice, { kind: 'none' }>): Promise<string>;
  startScreenAudioStream(selection: Exclude<ScreenAudioChoice, { kind: 'none' }>): Promise<void>;
  onScreenAudioFrames(callback: (data: ArrayBuffer) => void): () => void;
  stopScreenAudio(): Promise<void>;
  unmuteScreenAudio(): Promise<void>;
  pickFiles(request: PickFilesRequest): Promise<PickedFile[] | null>;
  saveFile(request: SaveFileRequest): Promise<{ path: string } | null>;
  shareFile(request: PickedFile): Promise<void>;
  checkForUpdate(): Promise<{ version: string; notes: string | undefined } | null>;
  downloadUpdate(onProgress: (percent: number) => void): Promise<void>;
  installUpdate(): Promise<void>;
  onScreenSharePick(pick: (sources: ScreenShareCandidate[]) => Promise<string | null>): () => void;
}

export function electronBridge(): ElectronBridge | undefined {
  return (globalThis as { sableElectron?: ElectronBridge }).sableElectron;
}

export function isElectron(): boolean {
  return electronBridge() !== undefined;
}
