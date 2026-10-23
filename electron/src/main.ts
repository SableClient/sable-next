import {
  app,
  BrowserWindow,
  desktopCapturer,
  dialog,
  ipcMain,
  Menu,
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
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { basename, extname, isAbsolute, join, relative, resolve } from 'node:path';
import { Readable } from 'node:stream';

import type {
  PickedFile,
  PickFilesRequest,
  SaveFileRequest,
} from '../../src/lib/platform/file-dialog-types';

import { deepLinksIn, deepLinkSchemes } from './deep-links';
import { claimSchemes } from './linux-schemes';
import { openExternal, originOf } from './navigation';
import { enforcePermissions } from './permissions';
import * as screenAudio from './screen-audio';
import { screenShareStreams, windowsScreenAudioSupported } from './screen-share';
import * as windowsScreenAudio from './windows-screen-audio';
import { initSentry, setTelemetryConsent } from './sentry';
import { readSettings, sanitize } from './settings';
import { ignoreBrokenPipes } from './stdio';
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

const IDENTIFIER = process.env.SABLE_IDENTIFIER ?? __SABLE_IDENTIFIER__;
const SCHEME = 'sable-app';
const DEEP_LINK_SCHEMES = deepLinkSchemes(IDENTIFIER);
const APP_ORIGIN = `${SCHEME}://app`;
const PANIC_MARKER = 'SABLE_CORE_PANIC ';

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
if (isLinux && settings.hardwareAcceleration && settings.hardwareVideoAcceleration) {
  enabledFeatures.push(
    'AcceleratedVideoDecodeLinuxGL',
    'AcceleratedVideoDecodeLinuxZeroCopyGL',
    'AcceleratedVideoEncoder'
  );
}
setFeatures(enabledFeatures, isLinux ? ['WaylandWpColorManagerV1'] : []);
if (!settings.smoothScrolling) app.commandLine.appendSwitch('disable-smooth-scrolling');
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

ignoreBrokenPipes([process.stdout, process.stderr]);

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

function policy(inlineScripts: string[] = []): string {
  const directives = { ...__SABLE_CSP__ };
  const hashes = inlineScripts.map(
    (script) => `'sha256-${createHash('sha256').update(script).digest('base64')}'`
  );
  directives['script-src'] = [directives['script-src'], ...hashes].join(' ');
  return Object.entries(directives)
    .map(([directive, sources]) => `${directive} ${sources}`)
    .join('; ');
}

const pagePolicies = new Map<string, string>();

async function pagePolicy(file: string): Promise<string> {
  const cached = pagePolicies.get(file);
  if (cached) return cached;
  const html = await readFile(file, 'utf8');
  const scripts = [...html.matchAll(/<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g)];
  const computed = policy(scripts.map(([, body]) => body));
  pagePolicies.set(file, computed);
  return computed;
}

const CONTENT_TYPES: Record<string, string> = {
  '.css': 'text/css',
  '.html': 'text/html; charset=utf-8',
  '.ico': 'image/x-icon',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.mjs': 'text/javascript',
  '.png': 'image/png',
  '.svg': 'image/svg+xml',
  '.ttf': 'font/ttf',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.webm': 'video/webm',
  '.webmanifest': 'application/manifest+json',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
};

async function serveApp(request: Request): Promise<Response> {
  const path = resolve(distDir, `.${decodeURIComponent(new URL(request.url).pathname)}`);
  const fromDist = relative(distDir, path);
  const inside = !fromDist.startsWith('..') && !isAbsolute(fromDist);
  const entry = inside ? await stat(path).catch(() => undefined) : undefined;
  const file = entry?.isDirectory() ? join(path, 'index.html') : path;
  const found = entry !== undefined && (await stat(file).catch(() => undefined))?.isFile();
  const target = found ? file : join(distDir, '404.html');

  const headers = new Headers({
    'Content-Type': CONTENT_TYPES[extname(target)] ?? 'application/octet-stream',
    'Content-Security-Policy': target.endsWith('.html') ? await pagePolicy(target) : policy(),
  });
  // Not `net.fetch`: one network loader per module exhausts Chromium's pool on first load.
  return new Response(Readable.toWeb(createReadStream(target)) as ReadableStream, { headers });
}

let mainWindow: BrowserWindow | null = null;
let core: UtilityProcess | null = null;
let quitting = false;
let coreStopped = false;
const CORE_STOP_LIMIT_MS = 5_000;
let pageListening = false;
let savedWindowState = readWindowState(windowStatePath);

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

function setCustomTitleBar(custom: boolean): void {
  if (custom === settings.customTitleBar) return;
  settings = { ...settings, customTitleBar: custom };
  void writeFile(settingsPath, JSON.stringify(settings));
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

ipcMain.handle('sable-take-deep-links', (event) =>
  isAppFrame(event.senderFrame) ? pendingDeepLinks.splice(0) : []
);

ipcMain.on('sable-deep-links-listening', (event) => {
  if (isAppFrame(event.senderFrame)) pageListening = true;
});

/** The core host saves what the runtime holds as it stops, so it must be asked before it is killed. */
function stopCore(child: UtilityProcess): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, CORE_STOP_LIMIT_MS);
    const done = () => {
      clearTimeout(timer);
      resolve();
    };
    child.once('message', done);
    child.once('exit', done);
    child.postMessage('stop');
  });
}

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

  let panic: string | undefined;
  let partial = '';
  child.stderr?.on('data', (chunk: Buffer) => {
    process.stderr.write(chunk);
    const lines = (partial + chunk.toString()).split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) {
      if (line.startsWith(PANIC_MARKER)) panic ??= line.slice(PANIC_MARKER.length);
    }
  });

  child.once('exit', (code) => {
    if (core === child) core = null;
    if (quitting || !mainWindow || mainWindow.isDestroyed()) return;
    mainWindow.webContents.send('sable-core-exit', panic ?? `core exited with code ${code}`);
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
  settings = next;
  setUpdateChannel(next.updateChannel);
  void writeFile(settingsPath, JSON.stringify(next));
  for (const contents of webContents.getAllWebContents()) {
    contents.setWebRTCIPHandlingPolicy(next.webRtcIpPolicy);
  }
});

ipcMain.on('sable-telemetry-consent', (event, enabled: unknown) => {
  if (!isAppFrame(event.senderFrame) || typeof enabled !== 'boolean') return;
  setTelemetryConsent(enabled);
});

ipcMain.handle('sable-tray-unread', (event, unread: unknown) => {
  if (!isAppFrame(event.senderFrame) || typeof unread !== 'boolean') return;
  desktopTray.setUnread(unread);
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
ipcMain.on('sable-window-toggle-maximize', (event) => {
  const window = windowOf(event);
  if (!window) return;
  if (window.isMaximized()) window.unmaximize();
  else window.maximize();
});
ipcMain.on('sable-window-close', (event) => windowOf(event)?.close());
ipcMain.handle('sable-window-is-maximized', (event) => windowOf(event)?.isMaximized() ?? false);

for (const [channel, kind] of [
  ['sable-core-connect', 'connect'],
  ['sable-runtime-connect', 'runtime'],
] as const) {
  ipcMain.on(channel, (event) => {
    if (event.ports.length !== 1 || !isAppFrame(event.senderFrame)) return;
    core ??= startCore();
    core.postMessage(kind, event.ports);
  });
}

function createWindow(): BrowserWindow {
  const restored = savedWindowState
    ? windowStateOnScreen(
        savedWindowState,
        screen.getAllDisplays().map((display) => display.workArea)
      )
    : undefined;
  const window = new BrowserWindow({
    width: restored?.width ?? 1280,
    height: restored?.height ?? 800,
    ...(restored ? { x: restored.x, y: restored.y } : {}),
    minWidth: MIN_WIDTH,
    minHeight: MIN_HEIGHT,
    show: false,
    autoHideMenuBar: true,
    ...(settings.customTitleBar &&
      (process.platform === 'darwin' ? { titleBarStyle: 'hidden' } : { frame: false })),
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      sandbox: true,
      contextIsolation: true,
      additionalArguments: [
        ...(supportsAutoUpdate() ? [] : ['--sable-disable-auto-update']),
        ...(windowsScreenAudioSupported() ? ['--sable-windows-screen-audio'] : []),
      ],
    },
  });

  const remember = () => {
    rememberWindowState(window);
  };
  window.on('move', remember);
  window.on('resize', remember);

  window.once('ready-to-show', () => {
    if (restored?.fullscreen) window.setFullScreen(true);
    else if (restored?.maximized) window.maximize();
    window.show();
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
    if (input.type !== 'keyDown' || input.isAutoRepeat) return;
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
  window.webContents.on('did-navigate', () => {
    pageListening = false;
    cancelPicks();
    screenAudio.stop();
  });
  window.webContents.on('render-process-gone', () => {
    screenAudio.stop();
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
  if (!isAppFrame(event.senderFrame) || !windowsScreenAudioSupported())
    throw new Error('screen audio is unavailable');
  windowsScreenAudio.start(selection, (data) => {
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
    const path = await writeWithoutClobbering(join(app.getPath('downloads'), name), bytes);
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

async function writeWithoutClobbering(path: string, bytes: Uint8Array): Promise<string> {
  try {
    await writeFile(path, bytes, { flag: 'wx' });
    return path;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const dot = path.lastIndexOf('.');
    const stamp = `-${String(Date.now())}`;
    const candidate =
      dot > 0 ? `${path.slice(0, dot)}${stamp}${path.slice(dot)}` : `${path}${stamp}`;
    await writeFile(candidate, bytes, { flag: 'wx' });
    return candidate;
  }
}

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

  app.on('before-quit', () => {
    quitting = true;
    screenAudio.stop();
    if (mainWindow && !mainWindow.isDestroyed()) rememberWindowState(mainWindow);
    persistWindowState();
    desktopTray.destroy();
  });

  app.on('before-quit', (event) => {
    if (!core || coreStopped) return;
    event.preventDefault();
    coreStopped = true;
    void stopCore(core).then(() => {
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
    registerUpdater(isAppFrame);
    setUpdateChannel(settings.updateChannel);
    mainWindow = createWindow();
  });
}
