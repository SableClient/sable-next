import { invoke, isTauri } from '@tauri-apps/api/core';

export function opensExternalUrls(): boolean {
  return isTauri();
}

export async function openExternalUrl(url: string): Promise<void> {
  await invoke('open_external_url', { url });
}

export function followExternalLink(event: MouseEvent, anchor: HTMLAnchorElement): void {
  if (anchor.target !== '_blank' || event.button > 1) return;
  if (!opensExternalUrls()) return;
  if (anchor.protocol !== 'http:' && anchor.protocol !== 'https:') return;

  event.preventDefault();
  const href = anchor.href;
  void openExternalUrl(href).catch((error: unknown) => {
    console.warn('[sable links] external link unavailable', href, error);
  });
}
