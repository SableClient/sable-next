import { app, Menu, nativeImage, Tray, type BrowserWindow, type NativeImage } from 'electron';

function withUnreadDot(base: NativeImage): NativeImage {
  const { width, height } = base.getSize();
  const bitmap = base.toBitmap();
  const radius = Math.min(width, height) * 0.2;
  const cx = width - radius - width * 0.04;
  const cy = height - radius - height * 0.04;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (Math.hypot(x + 0.5 - cx, y + 0.5 - cy) <= radius) {
        // Electron bitmaps use BGRA.
        bitmap.set([45, 45, 224, 255], (y * width + x) * 4);
      }
    }
  }
  return nativeImage.createFromBitmap(bitmap, { width, height });
}

export type CloseAction = 'close' | 'hide-app' | 'hide-to-tray';

/** macOS has no tray, and a destroyed window stops updating the dock badge, so closing hides the app there. */
export function closeAction(
  platform: NodeJS.Platform,
  quitting: boolean,
  closesToTray: boolean
): CloseAction {
  if (quitting) return 'close';
  if (platform === 'darwin') return 'hide-app';
  return closesToTray ? 'hide-to-tray' : 'close';
}

export function hideToTray(window: BrowserWindow): void {
  window.webContents.send('sable-window-hidden-to-tray');
  window.hide();
}

export class DesktopTray {
  private tray: Tray | null = null;
  private unread = false;
  private baseIcon: NativeImage | null = null;

  constructor(
    private readonly iconPath: string,
    private readonly getWindow: () => BrowserWindow | null,
    private readonly platform: NodeJS.Platform = process.platform
  ) {}

  get available(): boolean {
    return this.tray !== null;
  }

  setUnread(unread: boolean): void {
    if (this.unread === unread) return;
    if (this.tray && this.baseIcon) {
      this.tray.setImage(unread ? withUnreadDot(this.baseIcon) : this.baseIcon);
    }
    this.unread = unread;
  }

  showWindow(): void {
    const window = this.getWindow();
    if (!window || window.isDestroyed()) return;
    if (window.isMinimized()) window.restore();
    window.show();
    window.focus();
  }

  update(show: boolean): boolean {
    if (
      !show ||
      (this.platform !== 'win32' && this.platform !== 'linux' && this.platform !== 'freebsd')
    ) {
      const wasAvailable = this.available;
      this.destroy();
      const window = this.getWindow();
      if (wasAvailable && window && !window.isDestroyed() && !window.isVisible()) {
        this.showWindow();
      }
      return false;
    }
    if (this.tray) return true;

    try {
      const icon = nativeImage.createFromPath(this.iconPath);
      if (icon.isEmpty()) throw new Error(`Could not load tray icon: ${this.iconPath}`);
      this.baseIcon = icon;
      this.tray = new Tray(this.unread ? withUnreadDot(icon) : icon);
      this.tray.setToolTip('Sable');
      this.tray.setContextMenu(
        Menu.buildFromTemplate([
          {
            label: 'Show Sable',
            click: () => {
              this.showWindow();
            },
          },
          { type: 'separator' },
          {
            label: 'Quit Sable',
            click: () => {
              app.quit();
            },
          },
        ])
      );
      if (this.platform === 'win32') {
        this.tray.on('double-click', () => {
          const window = this.getWindow();
          if (!window || window.isDestroyed()) return;
          if (window.isVisible() && !window.isMinimized()) hideToTray(window);
          else this.showWindow();
        });
      } else {
        this.tray.on('click', () => {
          this.showWindow();
        });
      }
      return true;
    } catch (error) {
      this.destroy();
      console.error('[sable tray] could not create the tray icon', error);
      return false;
    }
  }

  destroy(): void {
    this.tray?.destroy();
    this.tray = null;
    this.baseIcon = null;
  }
}
