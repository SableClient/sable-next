import { EventEmitter } from 'node:events';
import type { BrowserWindow, MenuItemConstructorOptions, NativeImage } from 'electron';
import { beforeEach, expect, test, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  quit: vi.fn(),
  fail: false,
  menu: [] as MenuItemConstructorOptions[],
  baseIcon: {
    isEmpty: () => false,
    getSize: () => ({ width: 32, height: 32 }),
    toBitmap: () => Buffer.alloc(32 * 32 * 4, 100),
  },
  createFromBitmap: vi.fn((bitmap: Buffer, size: { width: number; height: number }) => ({
    bitmap,
    size,
  })),
}));

vi.mock('electron', () => ({
  app: { quit: mocks.quit },
  nativeImage: {
    createFromPath: () => mocks.baseIcon,
    createFromBitmap: mocks.createFromBitmap,
  },
  Menu: {
    buildFromTemplate: (items: MenuItemConstructorOptions[]) => {
      mocks.menu = items;
      return items;
    },
  },
  Tray: class extends EventEmitter {
    destroy = vi.fn();
    setToolTip = vi.fn();
    setContextMenu = vi.fn();
    setImage = vi.fn();
    constructor(readonly image: NativeImage) {
      super();
      if (mocks.fail) throw new Error('Tray unavailable');
      trayEvents.push(this);
    }
  },
}));

const trayEvents: (EventEmitter & {
  image: NativeImage;
  destroy: ReturnType<typeof vi.fn>;
  setImage: ReturnType<typeof vi.fn>;
})[] = [];

import { closeAction, DesktopTray, hideToTray } from './tray';

function setup(platform: NodeJS.Platform = 'win32') {
  let visible = true;
  let minimized = false;
  const window = {
    isDestroyed: () => false,
    isVisible: () => visible,
    isMinimized: () => minimized,
    show: vi.fn(() => {
      visible = true;
    }),
    hide: vi.fn(() => {
      visible = false;
    }),
    restore: vi.fn(() => {
      minimized = false;
    }),
    focus: vi.fn(),
    webContents: { send: vi.fn() },
  };
  const tray = new DesktopTray('/icon.ico', () => window as unknown as BrowserWindow, platform);
  return {
    tray,
    window,
    minimize: () => {
      minimized = true;
    },
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  trayEvents.length = 0;
  mocks.fail = false;
  mocks.menu = [];
});

test('Windows double-click hides and restores, while single click does not toggle', () => {
  const { tray, window, minimize } = setup();
  expect(tray.update(true)).toBe(true);
  trayEvents[0].emit('click');
  expect(window.hide).not.toHaveBeenCalled();
  trayEvents[0].emit('double-click');
  expect(window.hide).toHaveBeenCalledOnce();
  expect(window.webContents.send).toHaveBeenCalledWith('sable-window-hidden-to-tray');
  trayEvents[0].emit('double-click');
  expect(window.show).toHaveBeenCalledOnce();
  expect(window.focus).toHaveBeenCalledOnce();
  minimize();
  trayEvents[0].emit('double-click');
  expect(window.restore).toHaveBeenCalledOnce();
  expect(window.isVisible()).toBe(true);
});

test.each([
  ['darwin', false, false, 'hide-app'],
  ['darwin', true, false, 'close'],
  ['linux', false, true, 'hide-to-tray'],
  ['linux', false, false, 'close'],
  ['win32', true, true, 'close'],
] as const)(
  'closing the window on %s (quitting %s, closes to tray %s) is %s',
  (platform, quitting, closesToTray, action) => {
    expect(closeAction(platform, quitting, closesToTray)).toBe(action);
  }
);

test('the menu restores a hidden window and Quit exits the app', () => {
  const { tray, window } = setup();
  tray.update(true);
  hideToTray(window as unknown as BrowserWindow);
  mocks.menu[0].click?.(undefined as never, undefined, undefined as never);
  expect(window.show).toHaveBeenCalledOnce();
  mocks.menu[2].click?.(undefined as never, undefined, undefined as never);
  expect(mocks.quit).toHaveBeenCalledOnce();
});

test('disabling the tray reveals a hidden window, and re-enabling creates one icon', () => {
  const { tray, window } = setup();
  tray.update(true);
  tray.update(true);
  expect(trayEvents).toHaveLength(1);
  hideToTray(window as unknown as BrowserWindow);
  expect(tray.update(false)).toBe(false);
  expect(tray.available).toBe(false);
  expect(trayEvents[0].destroy).toHaveBeenCalledOnce();
  expect(window.show).toHaveBeenCalledOnce();
  expect(tray.update(true)).toBe(true);
  expect(trayEvents).toHaveLength(2);
  hideToTray(window as unknown as BrowserWindow);
  tray.destroy();
  expect(tray.available).toBe(false);
  expect(window.isVisible()).toBe(false);
});

test('tray creation failure leaves close/minimize available', () => {
  const error = vi.spyOn(console, 'error').mockImplementation(() => {});
  mocks.fail = true;
  const { tray } = setup();
  expect(tray.update(true)).toBe(false);
  expect(tray.available).toBe(false);
  error.mockRestore();
});

test('Linux retains click-to-show behavior', () => {
  const { tray, window } = setup('linux');
  tray.update(true);
  trayEvents[0].emit('click');
  expect(window.show).toHaveBeenCalledOnce();
  expect(window.hide).not.toHaveBeenCalled();
});

test('Linux shows an unread dot and clears it when read', () => {
  const { tray } = setup('linux');
  tray.update(true);
  tray.setUnread(true);
  const [bitmap, size] = mocks.createFromBitmap.mock.calls[0];
  const pixel = (x: number, y: number) => [
    ...bitmap.subarray((y * 32 + x) * 4, (y * 32 + x + 1) * 4),
  ];
  expect(size).toEqual({ width: 32, height: 32 });
  expect(pixel(25, 25)).toEqual([45, 45, 224, 255]);
  expect(pixel(0, 0)).toEqual([100, 100, 100, 100]);
  expect(trayEvents[0].setImage).toHaveBeenLastCalledWith(
    mocks.createFromBitmap.mock.results[0].value
  );
  tray.setUnread(true);
  expect(trayEvents[0].setImage).toHaveBeenCalledOnce();
  tray.setUnread(false);
  expect(trayEvents[0].setImage).toHaveBeenLastCalledWith(mocks.baseIcon);
});

test('tray recreation uses the current unread state', () => {
  const { tray } = setup('linux');
  tray.setUnread(true);
  tray.update(true);
  expect(trayEvents[0].image).toBe(mocks.createFromBitmap.mock.results[0].value);
  tray.update(false);
  tray.update(true);
  expect(trayEvents[1].image).toBe(mocks.createFromBitmap.mock.results[1].value);
  tray.update(false);
  tray.setUnread(false);
  tray.update(true);
  expect(trayEvents[2].image).toBe(mocks.baseIcon);
});
