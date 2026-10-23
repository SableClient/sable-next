import { contextBridge, ipcRenderer, type IpcRendererEvent } from 'electron';
import type {
  PickedFile,
  PickFilesRequest,
  SaveFileRequest,
} from '../../src/lib/platform/file-dialog-types';
import type { ScreenAudioListing } from '../../src/lib/platform/screen-audio-types';

interface ScreenShareCandidate {
  id: string;
  name: string;
  thumbnail: string;
}

type ScreenSharePick = (sources: ScreenShareCandidate[]) => Promise<string | null>;

let screenSharePick: ScreenSharePick | null = null;

contextBridge.exposeInMainWorld(
  '__SABLE_AUTO_UPDATE__',
  !process.argv.includes('--sable-disable-auto-update')
);

ipcRenderer.on('sable-pick-screen', (_event, request: number, sources: ScreenShareCandidate[]) => {
  const pick = screenSharePick ?? (() => Promise.resolve(null));
  void pick(sources)
    .catch(() => null)
    .then((id) => {
      ipcRenderer.send('sable-screen-picked', request, id);
    });
});

contextBridge.exposeInMainWorld('sableElectron', {
  platform: process.platform,
  screenAudioAvailable: process.argv.includes('--sable-screen-audio'),
  setTrayUnread: (unread: boolean) =>
    ipcRenderer.invoke('sable-tray-unread', unread) as Promise<void>,
  applyWindowSettings: (settings: unknown) =>
    ipcRenderer.invoke('sable-apply-window-settings', settings) as Promise<{
      trayAvailable: boolean;
    } | null>,
  minimizeWindow: () => {
    ipcRenderer.send('sable-window-minimize');
  },
  toggleMaximizeWindow: () => {
    ipcRenderer.send('sable-window-toggle-maximize');
  },
  closeWindow: () => {
    ipcRenderer.send('sable-window-close');
  },
  isWindowMaximized: () => ipcRenderer.invoke('sable-window-is-maximized') as Promise<boolean>,
  onWindowHiddenToTray: (callback: () => void) => {
    const listener = () => {
      callback();
    };
    ipcRenderer.on('sable-window-hidden-to-tray', listener);
    return () => {
      ipcRenderer.removeListener('sable-window-hidden-to-tray', listener);
    };
  },
  onWindowMaximized: (callback: (maximized: boolean) => void) => {
    const listener = (_event: IpcRendererEvent, maximized: boolean) => {
      callback(maximized);
    };
    ipcRenderer.on('sable-window-maximized', listener);
    return () => {
      ipcRenderer.removeListener('sable-window-maximized', listener);
    };
  },
  applySettings: (settings: unknown) => {
    ipcRenderer.send('sable-apply-settings', settings);
  },
  setTelemetryConsent: (enabled: boolean) => {
    ipcRenderer.send('sable-telemetry-consent', enabled);
  },
  takeDeepLinks: () => ipcRenderer.invoke('sable-take-deep-links') as Promise<string[]>,
  onDeepLinks: (callback: (urls: string[]) => void) => {
    const listener = (_event: IpcRendererEvent, urls: string[]) => {
      callback(urls);
    };
    ipcRenderer.on('sable-deep-links', listener);
    ipcRenderer.send('sable-deep-links-listening');
    return () => {
      ipcRenderer.removeListener('sable-deep-links', listener);
    };
  },
  screenAudioApps: () =>
    ipcRenderer.invoke('sable-screen-audio-apps') as Promise<ScreenAudioListing>,
  startScreenAudio: (selection: unknown) =>
    ipcRenderer.invoke('sable-screen-audio-start', selection) as Promise<string>,
  startScreenAudioStream: (selection: unknown) =>
    ipcRenderer.invoke('sable-screen-audio-stream-start', selection) as Promise<void>,
  onScreenAudioFrames: (callback: (data: ArrayBuffer) => void) => {
    const listener = (_event: IpcRendererEvent, data: Uint8Array) => {
      callback(new Uint8Array(data).buffer);
    };
    ipcRenderer.on('sable-screen-audio-frames', listener);
    return () => {
      ipcRenderer.removeListener('sable-screen-audio-frames', listener);
    };
  },
  stopScreenAudio: () => ipcRenderer.invoke('sable-screen-audio-stop') as Promise<void>,
  unmuteScreenAudio: () => ipcRenderer.invoke('sable-screen-audio-unmute') as Promise<void>,
  pickFiles: (request: PickFilesRequest) =>
    ipcRenderer.invoke('sable-pick-files', request) as Promise<PickedFile[] | null>,
  saveFile: (request: SaveFileRequest) =>
    ipcRenderer.invoke('sable-save-file', request) as Promise<{ path: string } | null>,
  shareFile: (request: PickedFile) =>
    ipcRenderer.invoke('sable-share-file', request) as Promise<void>,
  checkForUpdate: () =>
    ipcRenderer.invoke('sable-update-check') as Promise<{
      version: string;
      notes: string | undefined;
    } | null>,
  downloadUpdate: async (onProgress: (percent: number) => void) => {
    const listener = (_event: IpcRendererEvent, percent: number) => {
      onProgress(percent);
    };
    ipcRenderer.on('sable-update-progress', listener);
    try {
      await ipcRenderer.invoke('sable-update-download');
    } finally {
      ipcRenderer.removeListener('sable-update-progress', listener);
    }
  },
  installUpdate: () => ipcRenderer.invoke('sable-update-install') as Promise<void>,
  onScreenSharePick: (pick: ScreenSharePick) => {
    screenSharePick = pick;
    return () => {
      if (screenSharePick === pick) screenSharePick = null;
    };
  },
});

window.addEventListener('message', (event) => {
  if (event.source !== window || event.ports.length !== 1) return;
  const channel: unknown = event.data;
  if (channel !== 'sable-core-connect' && channel !== 'sable-runtime-connect') return;
  ipcRenderer.postMessage(channel, null, [...event.ports]);
});

ipcRenderer.on('sable-core-exit', (_event, message: string) => {
  window.postMessage({ sableCoreExit: message }, window.location.origin);
});
