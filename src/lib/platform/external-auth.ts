import { invoke, isTauri } from '@tauri-apps/api/core';

export interface ExternalAuthWindow {
  navigate: (url: string) => Promise<void>;
  close: () => void;
}

export function openExternalAuthWindow(name: string): ExternalAuthWindow | null {
  if (isTauri()) {
    return {
      navigate: async (url) => {
        await invoke('open_auth_url', { url });
      },
      close: () => {},
    };
  }

  const popup = window.open('about:blank', name, 'popup,width=520,height=720');
  if (!popup) return null;

  return {
    navigate: (url) => {
      popup.location.replace(url);

      return Promise.resolve();
    },
    close: () => {
      popup.close();
    },
  };
}

export async function openExternalAuthUrl(url: string): Promise<void> {
  if (isTauri()) {
    await invoke('open_auth_url', { url });

    return;
  }

  window.open(url, '_blank', 'noopener');
}
