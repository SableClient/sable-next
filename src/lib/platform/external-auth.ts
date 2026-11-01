import { invoke, isTauri } from '@tauri-apps/api/core';
import { platform } from '@tauri-apps/plugin-os';

import { electronBridge } from './electron';

export function isDesktopAuthClient(): boolean {
  return !!electronBridge();
}

export async function openSystemAuthUrl(url: string): Promise<void> {
  const electron = electronBridge();
  if (!electron) throw new Error('System browser fallback requires a desktop app');
  if (!['https:', 'http:'].includes(new URL(url).protocol)) {
    throw new Error('Authentication requires an HTTP or HTTPS URL');
  }
  await electron.openAuthInSystemBrowser(url);
}

export async function startAuthLoopback(): Promise<string> {
  const electron = electronBridge();
  if (!electron) throw new Error('Loopback redirects require a desktop app');
  return electron.startAuthLoopback();
}

export async function closeAuthLoopback(): Promise<void> {
  await electronBridge()?.closeAuthLoopback();
}

export interface ExternalAuthWindow {
  window?: Window;
  navigate: (url: string, callbackUri?: string) => Promise<boolean>;
  close: () => void | Promise<void>;
}

export function openExternalAuthWindow(
  name: string,
  { sheet = false }: { sheet?: boolean } = {}
): ExternalAuthWindow | null {
  const electron = electronBridge();
  if (isTauri() || electron) {
    let closed = false;
    let closing: Promise<void> | undefined;
    let opening: Promise<boolean> = Promise.resolve(false);
    let closeBrowser: (() => Promise<void>) | undefined;
    return {
      navigate: (url, callbackUri) => {
        opening = (async () => {
          if (closed) return false;
          if (electron) {
            closeBrowser = () => electron.closeAuthWindow(name);
            await electron.openAuthWindow(name, url);
            return false;
          }
          closeBrowser = () => invoke('close_in_app_auth_window', { id: name });
          const opened = await invoke<boolean | null>('open_in_app_auth_url', {
            id: name,
            url,
            callbackUri,
            sheet,
          });
          return opened === true;
        })();
        return opening;
      },
      close: () => {
        if (closed) return closing;
        closed = true;
        // Wait for Tauri presentation. Electron can close during page loading.
        closing = (electron ? Promise.resolve() : opening.catch(() => {}))
          .then(() => closeBrowser?.())
          .catch((error: unknown) => {
            console.warn('[sable auth] browser close failed', error);
          });
        return closing;
      },
    };
  }

  const popup = window.open('about:blank', name, 'popup,width=520,height=720');
  if (!popup) return null;

  return {
    window: popup,
    navigate: (url) => {
      popup.location.replace(url);

      return Promise.resolve(false);
    },
    close: () => {
      popup.close();
    },
  };
}

export async function openExternalAuthUrl(url: string): Promise<void> {
  const browser = openExternalAuthWindow(`sable-auth-${crypto.randomUUID()}`);
  if (!browser) throw new Error('Authentication popup was blocked');
  try {
    await browser.navigate(url);
  } catch (error) {
    await browser.close();
    throw error;
  }
}

export async function startInAppAuthSession(
  authUrl: string,
  callbackUri: string
): Promise<string | null> {
  if (!isTauri()) return null;
  if (platform() !== 'ios') return null;

  return invoke<string>('plugin:auth-session|start', {
    authUrl,
    callbackUrlScheme: new URL(callbackUri).protocol.slice(0, -1),
    ephemeral: false,
  });
}
