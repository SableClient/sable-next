import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
  nativeImage,
  protocol,
  screen,
  session,
  shell,
  systemPreferences,
  utilityProcess,
  webContents,
  type DesktopCapturerSource,
  type IpcMainEvent,
  type IpcMainInvokeEvent,
  type UtilityProcess,
  type WebFrameMain,
} from 'electron';
import { createReadStream } from 'node:fs';
import { readFile, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import mime from 'mime';
import { cspHeader, inlineScripts } from '../../scripts/build/csp.mjs';

import type {
  PickedFile,
  PickFilesRequest,
  SaveFileRequest,
} from '../../src/lib/platform/file-dialog-types';

import { deepLinksIn, deepLinkSchemes } from './deep-links';
import { AuthWindows } from './auth-window';
import { autostartAvailable, setLaunchAtLogin } from './autostart';
import { registerContextMenu } from './context-menu';
import { claimSchemes } from './linux-schemes';
import { openExternal, originOf } from './navigation';
import { enforcePermissions } from './permissions';
import { flushWritesBeforeQuit, writeJson } from './persistence';
import { writeDownload } from './downloads';
import { shareFile } from './share';
import * as screenAudio from './screen-audio';
import { available as screenAudioAvailable } from './audiofox';
import { screenShareStreams } from './screen-share';
import { initSentry, setTelemetryConsent } from './sentry';
import { readSettings, sanitize } from './settings';
import { captureCorePanic, ignoreBrokenPipes } from './stdio';
import { importTauriConfig } from './tauri-import';
import { DesktopTray, hideToTray } from './tray';
import { registerUpdater, setUpdateChannel, supportsAutoUpdate } from './updater';
import {
  MIN_HEIGHT,
  MIN_WIDTH,
  readWindowState,
  windowStateOnScreen,
  writeWindowState,
} from './window-state';

declare const __SABLE_CSP__: Record<string, string>;
declare const __SABLE_IDENTIFIER__: string;
declare const __SABLE_APP_VERSION__: string;

ignoreBrokenPipes([process.stdout, process.stderr]);

const IDENTIFIER = process.env.SABLE_IDENTIFIER ?? __SABLE_IDENTIFIER__;
const SCHEME = 'sable-app';
const DEEP_LINK_SCHEMES = deepLinkSchemes(IDENTIFIER);
const APP_ORIGIN = `${SCHEME}://app`;
const USER_AGENT = `Sable/${__SABLE_APP_VERSION__}`;

// Call libraries inspect navigator.userAgent to select Chromium workarounds.
app.userAgentFallback = `${USER_AGENT} ${app.userAgentFallback}`;

const devUrl = process.env.SABLE_DEV_URL;
const distDir = resolve(app.getAppPath(), process.env.SABLE_DIST ?? '../dist');
const isLinux = process.platform === 'linux';
const isWayland =
  isLinux && (process.env.XDG_SESSION_TYPE === 'wayland' || !!process.env.WAYLAND_DISPLAY);

function xdgDataHome(): string {
  const xdg = process.env.XDG_DATA_HOME;
  return xdg && isAbsolute(xdg) ? xdg : join(homedir(), '.local', 'share');
}

const dataDir = join(isLinux ? xdgDataHome() : app.getPath('appData'), IDENTIFIER);
app.setPath('userData', join(app.getPath('appData'), `${IDENTIFIER}.electron`));
if (!process.mas) {
  importTauriConfig(
    [
      join(
        process.env.XDG_CONFIG_HOME && isAbsolute(process.env.XDG_CONFIG_HOME)
          ? process.env.XDG_CONFIG_HOME
          : join(homedir(), '.config'),
        IDENTIFIER
      ),
      join(app.getPath('appData'), IDENTIFIER),
    ],
    app.getPath('userData')
  );
}
initSentry(app.getPath('userData'));
const settingsPath = join(app.getPath('userData'), 'settings.json');
let settings = readSettings(settingsPath);
const windowStatePath = join(app.getPath('userData'), 'window-state.json');

function setFeatures(enable: string[], disable: string[]): void {
  const read = (name: string) =>
    new Set(app.commandLine.getSwitchValue(name).split(',').filter(Boolean));
  const enabled = read('enable-features');
  const disabled = read('disable-features');
  for (const feature of enable) enabled.add(feature);
  for (const feature of disable) disabled.add(feature);
  for (const feature of disabled) enabled.delete(feature);

  for (const [name, features] of [
    ['enable-features', enabled],
    ['disable-features', disabled],
  ] as const) {
    app.commandLine.removeSwitch(name);
    if (features.size > 0) app.commandLine.appendSwitch(name, [...features].join(','));
  }
}

if (!settings.hardwareAcceleration) app.disableHardwareAcceleration();
const enabledFeatures = isLinux ? ['WebRtcPipeWireCamera'] : [];
if (settings.hardwareAcceleration && settings.hardwareVideoAcceleration) {
  enabledFeatures.push('AcceleratedVideoEncoder', 'AcceleratedVideoDecoder');
  if (isLinux) {
    enabledFeatures.push('AcceleratedVideoDecodeLinuxGL', 'AcceleratedVideoDecodeLinuxZeroCopyGL');
  }
}
setFeatures(enabledFeatures, [
  'HardwareMediaKeyHandling',
  'MediaSessionService',
  ...(isLinux ? ['WaylandWpColorManagerV1'] : []),
]);
if (!settings.smoothScrolling) app.commandLine.appendSwitch('disable-smooth-scrolling');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

if (process.platform !== 'darwin') Menu.setApplicationMenu(null);
if (process.platform === 'win32') {
  app.setAppUserModelId(
    IDENTIFIER === 'moe.sable.client' ? 'moe.sable.client' : 'moe.sable.next.electron'
  );
}

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      stream: true,
      codeCache: true,
      allowServiceWorkers: true,
    },
  },
]);

const appOrigin = devUrl ? originOf(devUrl) : APP_ORIGIN;

function isAppUrl(url: string | undefined): boolean {
  return !!url && originOf(url) === appOrigin;
}

function isAppFrame(frame: WebFrameMain | null | undefined): boolean {
  return frame?.origin === appOrigin;
}

const pagePolicies = new Map<string, string>();

async function pagePolicy(file: string): Promise<string> {
  const cached = pagePolicies.get(file);
  if (cached) return cached;
  const html = await readFile(file, 'utf8');
  const computed = cspHeader(__SABLE_CSP__, inlineScripts(html));
  pagePolicies.set(file, computed);
  return computed;
}

async function serveApp(request: Request): Promise<Response> {
  const path = resolve(distDir, `.${decodeURIComponent(new URL(request.url).pathname)}`);
  const fromDist = relative(distDir, path);
  const inside = !fromDist.startsWith('..') && !isAbsolute(fromDist);
  const entry = inside ? await stat(path).catch(() => undefined) : undefined;
  const file = entry?.isDirectory() ? join(path, 'index.html') : path;
  const found = entry !== undefined && (await stat(file).catch(() => undefined))?.isFile();
  const target = found ? file : join(distDir, '404.html');
  const type = mime.getType(target) ?? 'application/octet-stream';

  const headers = new Headers({
    'Content-Type': type === 'text/html' || type === 'text/plain' ? `${type}; charset=utf-8` : type,
    'Content-Security-Policy': target.endsWith('.html')
      ? await pagePolicy(target)
      : cspHeader(__SABLE_CSP__),
  });
  // Not `net.fetch`: one network loader per module exhausts Chromium's pool on first load.
  return new Response(Readable.toWeb(createReadStream(target)) as ReadableStream, { headers });
}

let mainWindow: BrowserWindow | null = null;
let core: UtilityProcess | null = null;
let quitting = false;
let pageListening = false;
let savedWindowState = readWindowState(windowStatePath);
let startHidden = settings.startMinimized || process.argv.includes('--start-minimized');
let lastCrashReload = 0;
const CRASH_RELOAD_INTERVAL_MS = 30_000;
const MAX_ZOOM_LEVEL = 3;

function rememberWindowState(window: BrowserWindow): void {
  if (window.isDestroyed()) return;
  savedWindowState = {
    ...window.getNormalBounds(),
    maximized: window.isMaximized(),
    fullscreen: window.isFullScreen(),
  };
}

function persistWindowState(): void {
  if (savedWindowState) writeWindowState(windowStatePath, savedWindowState);
}

interface DesktopWindowSettings {
  closeToTray: boolean;
  minimizeToTray: boolean;
  showSystemTrayIcon: boolean;
}

let desktopWindowSettings: DesktopWindowSettings = {
  closeToTray: false,
  minimizeToTray: false,
  showSystemTrayIcon: true,
};

function showMainWindow(): void {
  desktopTray.showWindow();
}

function trayIconPath(): string {
  const extension = process.platform === 'win32' ? 'ico' : 'png';
  return app.isPackaged
    ? join(process.resourcesPath, `sable-tray.${extension}`)
    : join(app.getAppPath(), `../src-tauri/icons/icon.${extension}`);
}

const desktopTray = new DesktopTray(trayIconPath(), () => mainWindow);

function sanitizeDesktopWindowSettings(value: unknown): DesktopWindowSettings {
  const stored = (typeof value === 'object' && value !== null ? value : {}) as Record<
    string,
    unknown
  >;
  return {
    closeToTray: stored.closeToTray === true,
    minimizeToTray: stored.minimizeToTray === true,
    showSystemTrayIcon: stored.showSystemTrayIcon !== false,
  };
}

function isCustomTitleBarRequested(value: unknown): boolean {
  return (value as { useCustomTitleBar?: unknown } | null)?.useCustomTitleBar === true;
}

function persistSettings(): void {
  void writeJson(settingsPath, settings).catch((error: unknown) => {
    console.error('[sable settings] could not save settings', error);
  });
}

function setCustomTitleBar(custom: boolean): void {
  if (custom === settings.customTitleBar) return;
  settings = { ...settings, customTitleBar: custom };
  persistSettings();
  if (!mainWindow || mainWindow.isDestroyed()) return;

  const previous = mainWindow;
  rememberWindowState(previous);
  mainWindow = createWindow();
  previous.destroy();
}

const pendingDeepLinks = deepLinksIn(process.argv, DEEP_LINK_SCHEMES);

function deliverDeepLinks(urls: string[]): void {
  if (urls.length === 0) return;
  if (mainWindow && pageListening) mainWindow.webContents.send('sable-deep-links', urls);
  else pendingDeepLinks.push(...urls);
}

const authWindows = new AuthWindows((url) => {
  deliverDeepLinks([url]);
});

ipcMain.handle('sable-auth-open', async (event, id: string, url: string, callbackUri?: string) => {
  if (!isAppFrame(event.senderFrame) || event.sender !== mainWindow?.webContents) {
    throw new Error('Invalid authentication origin');
  }
  if (
    typeof id !== 'string' ||
    typeof url !== 'string' ||
    (callbackUri !== undefined && typeof callbackUri !== 'string')
  ) {
    throw new Error('Invalid authentication request');
  }
  await authWindows.open(mainWindow, id, url, callbackUri);
});

ipcMain.handle('sable-auth-close', (event, id: string) => {
  if (
    isAppFrame(event.senderFrame) &&
    event.sender === mainWindow?.webContents &&
    typeof id === 'string'
  ) {
    authWindows.close(id);
  }
});

ipcMain.handle('sable-auth-external', async (event, url: string) => {
  if (!isAppFrame(event.senderFrame) || event.sender !== mainWindow?.webContents) {
    throw new Error('Invalid authentication origin');
  }
  const parsed = typeof url === 'string' ? URL.parse(url) : null;
  if (!parsed || !['http:', 'https:'].includes(parsed.protocol)) {
    throw new Error('Authentication requires an HTTP or HTTPS URL');
  }
  await shell.openExternal(url);
});

ipcMain.handle('sable-take-deep-links', (event) =>
  isAppFrame(event.senderFrame) ? pendingDeepLinks.splice(0) : []
);

ipcMain.on('sable-deep-links-listening', (event) => {
  if (isAppFrame(event.senderFrame)) pageListening = true;
});

const PANIC_GRACE_MS = 1000;

function startCore(): UtilityProcess {
  const child = utilityProcess.fork(join(__dirname, 'core-host.cjs'), [], {
    serviceName: 'Sable Core',
    // Explorer launches on Windows have no stdout handle for Chromium to inherit.
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, SABLE_DATA_DIR: dataDir },
  });

  child.stdout?.on('data', (chunk: Buffer) => {
    process.stdout.write(chunk);
  });

  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
  });
  const panic = captureCorePanic(child.stderr).catch((error: unknown) => {
    console.error('[sable core] could not read stderr', error);
    return undefined;
  });

  child.once('exit', (code) => {
    if (core === child) core = null;
    void Promise.race([panic, delay(PANIC_GRACE_MS, undefined, { ref: false })]).then((message) => {
      if (quitting || !mainWindow || mainWindow.isDestroyed()) return;
      mainWindow.webContents.send('sable-core-exit', message ?? `core exited with code ${code}`);
    });
  });

  return child;
}

app.on('web-contents-created', (_event, contents) => {
  contents.setWebRTCIPHandlingPolicy(settings.webRtcIpPolicy);
});

ipcMain.on('sable-apply-settings', (event, value: unknown) => {
  if (!isAppFrame(event.senderFrame)) return;
  const next = { ...sanitize(value), customTitleBar: settings.customTitleBar };
  if (JSON.stringify(next) === JSON.stringify(settings)) return;
  if (next.launchAtLogin !== settings.launchAtLogin && autostartAvailable()) {
    void setLaunchAtLogin(
      next.launchAtLogin,
      IDENTIFIER,
      join(app.getPath('appData'), 'autostart')
    ).catch((error: unknown) => {
      console.error('[sable autostart] could not update the login item', error);
    });
  }
  settings = next;
  setUpdateChannel(next.updateChannel);
  persistSettings();
  for (const contents of webContents.getAllWebContents()) {
    contents.setWebRTCIPHandlingPolicy(next.webRtcIpPolicy);
  }
});

ipcMain.on('sable-telemetry-consent', (event, enabled: unknown) => {
  if (!isAppFrame(event.senderFrame) || typeof enabled !== 'boolean') return;
  setTelemetryConsent(enabled);
});

ipcMain.handle('sable-badge', (event, count: unknown, overlay: unknown) => {
  if (!isAppFrame(event.senderFrame) || !Number.isInteger(count) || (count as number) < 0) return;
  const unread = count as number;
  desktopTray.setUnread(unread > 0);
  if (process.platform !== 'win32') {
    app.setBadgeCount(unread);
    return;
  }
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) return;
  if (unread > 0 && typeof overlay === 'string') {
    window.setOverlayIcon(nativeImage.createFromDataURL(overlay), `${unread} unread`);
  } else {
    window.setOverlayIcon(null, '');
  }
});

ipcMain.on('sable-request-attention', (event) => {
  const window = windowOf(event);
  if (window && !window.isFocused()) window.flashFrame(true);
});

ipcMain.handle('sable-clear-web-caches', async (event) => {
  if (!isAppFrame(event.senderFrame)) return;
  await event.sender.session.clearCache();
  await event.sender.session.clearCodeCaches({});
});

ipcMain.handle('sable-apply-window-settings', (event, value: unknown) => {
  if (!isAppFrame(event.senderFrame)) return null;
  desktopWindowSettings = sanitizeDesktopWindowSettings(value);
  setCustomTitleBar(isCustomTitleBarRequested(value));
  return { trayAvailable: desktopTray.update(desktopWindowSettings.showSystemTrayIcon) };
});

function windowOf(event: IpcMainEvent | IpcMainInvokeEvent): BrowserWindow | null {
  return isAppFrame(event.senderFrame) ? BrowserWindow.fromWebContents(event.sender) : null;
}

ipcMain.on('sable-window-minimize', (event) => windowOf(event)?.minimize());
ipcMain.on('sable-window-show', (event) => {
  if (isAppFrame(event.senderFrame)) showMainWindow();
});
ipcMain.on('sable-window-toggle-maximize', (event) => {
  const window = windowOf(event);
  if (!window) return;
  if (window.isMaximized()) window.unmaximize();
  else window.maximize();
});
ipcMain.on('sable-window-close', (event) => windowOf(event)?.close());
ipcMain.handle('sable-window-is-maximized', (event) => windowOf(event)?.isMaximized() ?? false);

ipcMain.on('sable-core-connect', (event) => {
  if (event.ports.length !== 1 || !isAppFrame(event.senderFrame)) return;
  core ??= startCore();
  core.postMessage('connect', event.ports);
});

function createWindow(): BrowserWindow {
  const restored = savedWindowState
    ? windowStateOnScreen(
        savedWindowState,
        screen.getAllDisplays().map((display) => display.workArea)
      )
    : undefined;
  const { workArea } = restored ? screen.getDisplayMatching(restored) : screen.getPrimaryDisplay();
  const window = new BrowserWindow({
    width: Math.min(restored?.width ?? 1280, workArea.width),
    height: Math.min(restored?.height ?? 800, workArea.height),
    ...(restored ? { x: restored.x, y: restored.y } : {}),
    minWidth: Math.min(MIN_WIDTH, workArea.width),
    minHeight: Math.min(MIN_HEIGHT, workArea.height),
    show: false,
    autoHideMenuBar: true,
    ...(settings.customTitleBar &&
      (process.platform === 'darwin' ? { titleBarStyle: 'hidden' } : { frame: false })),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      backgroundThrottling: false,
      additionalArguments: [
        ...(supportsAutoUpdate() ? [] : ['--sable-disable-auto-update']),
        ...(screenAudioAvailable ? ['--sable-screen-audio'] : []),
        ...(autostartAvailable() ? ['--sable-autostart'] : []),
      ],
    },
  });

  const remember = () => {
    rememberWindowState(window);
  };
  window.on('move', remember);
  window.on('resize', remember);

  window.once('ready-to-show', () => {
    if (startHidden) {
      startHidden = false;
      if (process.platform === 'darwin' || desktopTray.available) return;
      window.minimize();
      return;
    }
    if (restored?.fullscreen) window.setFullScreen(true);
    else if (restored?.maximized) window.maximize();
    window.show();
  });
  window.on('focus', () => {
    window.flashFrame(false);
  });
  window.on('closed', () => {
    if (mainWindow !== window) return;
    screenAudio.stop();
    mainWindow = null;
    pageListening = false;
  });
  window.on('close', (event) => {
    rememberWindowState(window);
    persistWindowState();
    if (!quitting && desktopWindowSettings.closeToTray && desktopTray.available) {
      event.preventDefault();
      hideToTray(window);
    }
  });
  const reportMaximized = () => {
    window.webContents.send('sable-window-maximized', window.isMaximized());
  };
  window.on('maximize', reportMaximized);
  window.on('unmaximize', reportMaximized);
  window.on('minimize', () => {
    if (!quitting && desktopWindowSettings.minimizeToTray && desktopTray.available) {
      hideToTray(window);
    }
  });
  window.webContents.on('before-input-event', (event, input) => {
    if (input.type !== 'keyDown') return;
    if (process.platform !== 'darwin' && input.control && !input.alt && !input.meta) {
      const step = { '=': 0.5, '+': 0.5, '-': -0.5, '0': 0 }[input.key];
      if (step !== undefined) {
        event.preventDefault();
        const level = step === 0 ? 0 : window.webContents.getZoomLevel() + step;
        window.webContents.setZoomLevel(Math.min(MAX_ZOOM_LEVEL, Math.max(-MAX_ZOOM_LEVEL, level)));
        return;
      }
    }
    if (input.isAutoRepeat) return;
    const f12 = input.key === 'F12' && !input.control && !input.shift && !input.alt && !input.meta;
    const inspect =
      input.key.toLowerCase() === 'i' &&
      (process.platform === 'darwin'
        ? input.meta && input.alt && !input.control && !input.shift
        : input.control && input.shift && !input.meta && !input.alt);
    if (!f12 && !inspect) return;
    event.preventDefault();
    window.webContents.toggleDevTools();
  });
  registerContextMenu(window);
  window.webContents.on('did-navigate', () => {
    pageListening = false;
    cancelPicks();
    screenAudio.stop();
  });
  window.webContents.on('render-process-gone', (_event, details) => {
    screenAudio.stop();
    if (details.reason === 'clean-exit' || quitting) return;
    const now = Date.now();
    if (now - lastCrashReload < CRASH_RELOAD_INTERVAL_MS) return;
    lastCrashReload = now;
    window.webContents.reload();
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openExternal(url);
  });

  void window.loadURL(devUrl ?? `${APP_ORIGIN}/`);
  return window;
}

let nextPickRequest = 1;
const pendingPicks = new Map<number, (id: string | null) => void>();

ipcMain.on('sable-screen-picked', (event, request: unknown, id: unknown) => {
  if (!isAppFrame(event.senderFrame) || typeof request !== 'number') return;
  pendingPicks.get(request)?.(typeof id === 'string' ? id : null);
  pendingPicks.delete(request);
});

ipcMain.handle('sable-screen-audio-apps', (event) =>
  isAppFrame(event.senderFrame) ? screenAudio.listApps() : { apps: [], status: 'unavailable' }
);

ipcMain.handle('sable-screen-audio-start', (event, selection: unknown) => {
  if (!isAppFrame(event.senderFrame)) throw new Error('not the app');
  return screenAudio.start(selection);
});

ipcMain.handle('sable-screen-audio-stream-start', (event, selection: unknown) => {
  if (!isAppFrame(event.senderFrame) || !screenAudioAvailable)
    throw new Error('screen audio is unavailable');
  return screenAudio.startStream(selection, (data) => {
    if (!event.sender.isDestroyed() && isAppFrame(event.senderFrame))
      event.sender.send('sable-screen-audio-frames', data);
  });
});

ipcMain.handle('sable-screen-audio-stop', (event) => {
  if (isAppFrame(event.senderFrame)) screenAudio.stop();
});

ipcMain.handle('sable-screen-audio-unmute', (event) => {
  if (isAppFrame(event.senderFrame)) screenAudio.unmute();
});

ipcMain.handle('sable-pick-files', async (event, request: unknown) => {
  if (!isAppFrame(event.senderFrame)) return null;
  const { filters, multiple } = (request ?? {}) as Partial<PickFilesRequest>;
  const window = BrowserWindow.fromWebContents(event.sender);
  const properties: ('openFile' | 'multiSelections')[] = multiple
    ? ['openFile', 'multiSelections']
    : ['openFile'];
  const options = { properties, filters };
  const { canceled, filePaths } = window
    ? await dialog.showOpenDialog(window, options)
    : await dialog.showOpenDialog(options);
  if (canceled) return [];

  const picked: PickedFile[] = [];
  for (const filePath of filePaths) {
    picked.push({ name: basename(filePath), bytes: new Uint8Array(await readFile(filePath)) });
  }
  return picked;
});

ipcMain.handle('sable-save-file', async (event, request: unknown) => {
  if (!isAppFrame(event.senderFrame)) return null;
  const { name, bytes, filters, askLocation } = (request ?? {}) as Partial<SaveFileRequest>;
  if (typeof name !== 'string' || !(bytes instanceof Uint8Array)) return null;

  const window = BrowserWindow.fromWebContents(event.sender);
  if (!askLocation) {
    const path = await writeDownload(app.getPath('downloads'), name, bytes);
    return { path };
  }

  const options = { defaultPath: name, filters };
  const { canceled, filePath } = window
    ? await dialog.showSaveDialog(window, options)
    : await dialog.showSaveDialog(options);
  if (canceled) return null;

  await writeFile(filePath, bytes);
  return { path: filePath };
});

ipcMain.handle('sable-share-file', async (event, request: unknown) => {
  if (!isAppFrame(event.senderFrame)) throw new Error('Invalid share origin');
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window) throw new Error('No share window');
  await shareFile(window, app.getPath('userData'), request);
});

function cancelPicks(): void {
  for (const resolve of pendingPicks.values()) resolve(null);
  pendingPicks.clear();
}

function pickScreenSource(sources: DesktopCapturerSource[]): Promise<string | null> {
  if (!mainWindow || sources.length === 0) return Promise.resolve(null);
  const request = nextPickRequest++;
  const candidates = sources.map(({ id, name, thumbnail }) => ({
    id,
    name,
    thumbnail: thumbnail.toDataURL(),
  }));
  mainWindow.webContents.send('sable-pick-screen', request, candidates);
  return new Promise((resolve) => {
    pendingPicks.set(request, resolve);
  });
}

async function chooseShareSource(): Promise<DesktopCapturerSource | undefined> {
  // Enumeration requests macOS consent; a status check alone does not.
  const thumbnailSize = isWayland ? { width: 1920, height: 1080 } : { width: 320, height: 180 };
  const sources = await desktopCapturer
    .getSources({ types: ['screen', 'window'], thumbnailSize })
    .catch((error: unknown) => {
      console.error('[sable screen share] could not list sources', error);
      return [];
    });
  if (process.platform === 'darwin') {
    const access = systemPreferences.getMediaAccessStatus('screen');
    if (access === 'denied' || access === 'restricted') {
      const { response } = await dialog.showMessageBox({
        type: 'warning',
        message: 'Screen recording access is required to share your screen.',
        detail:
          'Allow Sable in System Settings → Privacy & Security → Screen Recording, then restart Sable.',
        buttons: ['Open System Settings', 'Cancel'],
        defaultId: 0,
        cancelId: 1,
      });
      if (response === 0) {
        await shell.openExternal(
          'x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture'
        );
      }
      return undefined;
    }
  }
  const id = isWayland ? sources[0]?.id : await pickScreenSource(sources);
  return sources.find((candidate) => candidate.id === id);
}

function registerScreenShare(): void {
  session.defaultSession.setDisplayMediaRequestHandler((request, callback) => {
    if (!isAppFrame(request.frame)) {
      callback(null);
      return;
    }
    void chooseShareSource().then(
      (source) => {
        callback(source ? screenShareStreams(source, request.audioRequested) : null);
      },
      (error: unknown) => {
        console.error('[sable screen share] could not select a source', error);
        callback(null);
      }
    );
  });
}

function registerDeepLinks(): void {
  if (isLinux && process.env.FLATPAK_ID) return;
  if (isLinux) {
    void claimSchemes(join(xdgDataHome(), 'applications'), IDENTIFIER, DEEP_LINK_SCHEMES);
  } else if (app.isPackaged) {
    for (const scheme of DEEP_LINK_SCHEMES) {
      app.setAsDefaultProtocolClient(scheme);
    }
  }
}

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', (_event, argv) => {
    deliverDeepLinks(deepLinksIn(argv, DEEP_LINK_SCHEMES));
    if (!mainWindow && app.isReady()) mainWindow = createWindow();
    showMainWindow();
  });

  app.on('open-url', (event, url) => {
    event.preventDefault();
    const urls = deepLinksIn([url], DEEP_LINK_SCHEMES);
    if (urls.length === 0) return;
    deliverDeepLinks(urls);
    if (!mainWindow && app.isReady()) mainWindow = createWindow();
    showMainWindow();
  });

  app.on('before-quit', (event) => {
    if (!quitting) {
      quitting = true;
      screenAudio.stop();
      if (mainWindow && !mainWindow.isDestroyed()) rememberWindowState(mainWindow);
      persistWindowState();
      desktopTray.destroy();
    }
    flushWritesBeforeQuit(event, () => {
      app.quit();
    });
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });

  app.on('activate', () => {
    if (mainWindow) showMainWindow();
    else if (app.isReady()) mainWindow = createWindow();
  });

  void app.whenReady().then(() => {
    registerDeepLinks();
    desktopTray.update(desktopWindowSettings.showSystemTrayIcon);
    core = startCore();
    protocol.handle(SCHEME, serveApp);
    enforcePermissions(
      session.defaultSession,
      join(app.getPath('userData'), 'permissions.json'),
      isAppUrl,
      () => mainWindow
    );
    registerScreenShare();
    if (process.platform !== 'darwin') {
      const available = new Set(session.defaultSession.availableSpellCheckerLanguages);
      const languages = app
        .getPreferredSystemLanguages()
        .flatMap((language) => [language, language.split('-')[0]])
        .filter(
          (language, index, all) => available.has(language) && all.indexOf(language) === index
        );
      if (languages.length > 0) session.defaultSession.setSpellCheckerLanguages(languages);
    }
    registerUpdater(isAppFrame);
    setUpdateChannel(settings.updateChannel);
    mainWindow = createWindow();
  });
}
