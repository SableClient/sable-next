import { invoke, isTauri } from '@tauri-apps/api/core';

import { electronBridge } from './electron.js';
import { externalLinkRequest } from './external-link-request.svelte.js';
import { isOpenableProtocol, isWebProtocol } from './link-schemes.js';

export function opensExternalUrls(): boolean {
  return isTauri();
}

export async function openExternalUrl(url: string): Promise<void> {
  await invoke('open_external_url', { url });
}

/** Hands a link the user confirmed to whichever app the OS has registered for its scheme. */
export async function openAppLink(url: string): Promise<void> {
  const electron = electronBridge();
  if (electron) await electron.openAppLink(url);
  else if (isTauri()) await openExternalUrl(url);
  else window.location.assign(url);
}

export function followExternalLink(event: MouseEvent, anchor: HTMLAnchorElement): void {
  if (anchor.target !== '_blank' || event.button > 1) return;
  const protocol = anchor.protocol;
  if (protocol === 'matrix:' || anchor.origin === location.origin) return;

  if (!isWebProtocol(protocol)) {
    // The webview must never navigate to a scheme it cannot load: on Android that aborts the app.
    event.preventDefault();
    if (isOpenableProtocol(protocol)) externalLinkRequest.current = anchor.href;
    return;
  }
  if (!opensExternalUrls()) return;

  event.preventDefault();
  const href = anchor.href;
  void openExternalUrl(href).catch((error: unknown) => {
    console.warn('[sable links] external link unavailable', href, error);
  });
}
