import { EventEmitter } from 'node:events';
import { beforeEach, expect, test, vi } from 'vitest';
import type { BrowserWindow } from 'electron';

const created = vi.hoisted(
  () =>
    [] as {
      options: Record<string, unknown>;
      webContents: EventEmitter & { setWindowOpenHandler: ReturnType<typeof vi.fn> };
      destroy: ReturnType<typeof vi.fn>;
    }[]
);

vi.mock('electron', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    BrowserWindow: class extends EventEmitter {
      webContents = Object.assign(new EventEmitter(), { setWindowOpenHandler: vi.fn() });
      destroyed = false;
      destroy = vi.fn(() => {
        this.destroyed = true;
        this.emit('closed');
      });
      constructor(public options: Record<string, unknown>) {
        super();
        created.push(this);
      }
      isDestroyed() {
        return this.destroyed;
      }
      loadURL = vi.fn(() => Promise.resolve());
    },
  };
});

import { AuthWindows } from './auth-window';

beforeEach(() => {
  created.length = 0;
});

test('disables Node, blocks file navigation and closes with the parent', async () => {
  const parent = new EventEmitter() as unknown as BrowserWindow;
  const windows = new AuthWindows();
  await windows.open(parent, 'approval', 'https://auth.example.org/device');
  expect(created[0].options.webPreferences).toEqual({
    nodeIntegration: false,
    contextIsolation: true,
    sandbox: true,
  });
  const preventDefault = vi.fn();
  created[0].webContents.emit('will-navigate', { preventDefault }, 'file:///etc/passwd');
  expect(preventDefault).toHaveBeenCalledOnce();
  parent.emit('closed');
  expect(created[0].destroy).toHaveBeenCalledOnce();
});

test.each(['javascript:alert(1)', 'file:///etc/passwd', 'invalid'])(
  'rejects invalid auth URL %s before creating a popup',
  async (url) => {
    const windows = new AuthWindows();
    await expect(windows.open({} as BrowserWindow, 'approval', url)).rejects.toThrow('HTTP');
    expect(created).toHaveLength(0);
  }
);
