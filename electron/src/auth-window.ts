import { BrowserWindow } from 'electron';

export class AuthWindows {
  private readonly windows = new Map<string, BrowserWindow>();

  async open(parent: BrowserWindow, id: string, url: string): Promise<void> {
    const parsed = URL.parse(url);
    if (!parsed || !['https:', 'http:'].includes(parsed.protocol)) {
      throw new Error('Authentication requires an HTTP or HTTPS URL');
    }
    this.close(id);
    const popup = new BrowserWindow({
      parent,
      width: 520,
      height: 720,
      title: 'Sable',
      autoHideMenuBar: true,
      webPreferences: { nodeIntegration: false, contextIsolation: true, sandbox: true },
    });
    this.windows.set(id, popup);
    const closeWithParent = () => {
      if (!popup.isDestroyed()) popup.destroy();
    };
    popup.once('closed', () => {
      if (this.windows.get(id) === popup) this.windows.delete(id);
      parent.removeListener('closed', closeWithParent);
    });
    parent.once('closed', closeWithParent);
    const navigate = (event: { preventDefault(): void }, target: string) => {
      const destination = URL.parse(target);
      if (!destination || !['https:', 'http:'].includes(destination.protocol)) {
        event.preventDefault();
      }
    };
    popup.webContents.on('will-navigate', navigate);
    popup.webContents.on('will-redirect', navigate);
    popup.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    try {
      await popup.loadURL(url);
    } catch (error) {
      // Closing the popup or blocking a redirect aborts the pending navigation.
      if (!popup.isDestroyed()) {
        this.close(id);
        throw error;
      }
    }
  }

  close(id: string): void {
    const popup = this.windows.get(id);
    this.windows.delete(id);
    if (popup && !popup.isDestroyed()) popup.destroy();
  }
}
