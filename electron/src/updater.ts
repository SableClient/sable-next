import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { app, ipcMain, type WebFrameMain } from 'electron';
import { autoUpdater, type UpdateInfo } from 'electron-updater';

type IsAppFrame = (frame: WebFrameMain | null | undefined) => boolean;

function notesOf({ releaseNotes }: UpdateInfo): string | undefined {
  if (typeof releaseNotes === 'string') return releaseNotes;
  return releaseNotes?.map((entry) => entry.note).join('\n') || undefined;
}

const FEEDS = {
  stable: 'https://git.sable.moe/SableClient/sable-next/releases/download/latest/',
  nightly: 'https://git.sable.moe/SableClient/sable-next/releases/download/nightly/',
};
const builtChannel = app.getVersion().includes('-nightly.') ? 'nightly' : 'stable';
const feedChannel = (channel: keyof typeof FEEDS) => (channel === 'stable' ? 'latest' : 'nightly');

const { autoUpdate } = JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')) as {
  autoUpdate?: boolean;
};

export function supportsAutoUpdate(): boolean {
  return (
    app.isPackaged &&
    autoUpdate !== false &&
    !process.mas &&
    !process.env.FLATPAK_ID &&
    (process.platform !== 'linux' || Boolean(process.env.APPIMAGE))
  );
}

export function setUpdateChannel(channel: keyof typeof FEEDS): void {
  if (!supportsAutoUpdate()) return;
  autoUpdater.setFeedURL({
    provider: 'generic',
    url: FEEDS[channel],
    channel: feedChannel(channel),
    // Forgejo serves multipart byteranges too slowly.
    useMultipleRangeRequest: false,
  });
  // Moving from nightly to an older stable is a downgrade to the updater.
  autoUpdater.allowDowngrade = channel !== builtChannel;
}

export function registerUpdater(isAppFrame: IsAppFrame): void {
  const enabled = supportsAutoUpdate();
  autoUpdater.autoDownload = false;
  autoUpdater.autoInstallOnAppQuit = false;

  ipcMain.handle('sable-update-check', async (event) => {
    if (!enabled || !isAppFrame(event.senderFrame)) return null;
    const result = await autoUpdater.checkForUpdates();
    if (!result?.isUpdateAvailable) return null;
    return { version: result.updateInfo.version, notes: notesOf(result.updateInfo) };
  });

  ipcMain.handle('sable-update-latest-version', async (event) => {
    if (enabled || !app.isPackaged || !isAppFrame(event.senderFrame)) return null;
    const feed = `${FEEDS[builtChannel]}${feedChannel(builtChannel)}-linux.yml`;
    const response = await fetch(feed, { cache: 'no-store' });
    if (!response.ok) throw new Error(`Update feed request failed: ${String(response.status)}`);
    return /^version:\s*(\S+)$/m.exec(await response.text())?.[1] ?? null;
  });

  ipcMain.handle('sable-update-download', async (event) => {
    if (!enabled || !isAppFrame(event.senderFrame)) throw new Error('not the app');
    const { sender } = event;
    const onProgress = (progress: { percent: number }) => {
      if (!sender.isDestroyed()) sender.send('sable-update-progress', Math.round(progress.percent));
    };
    autoUpdater.on('download-progress', onProgress);
    try {
      await autoUpdater.downloadUpdate();
    } finally {
      autoUpdater.off('download-progress', onProgress);
    }
  });

  ipcMain.handle('sable-update-install', (event) => {
    if (enabled && isAppFrame(event.senderFrame)) autoUpdater.quitAndInstall();
  });
}
