import { shell } from 'electron';

import { isOpenableProtocol } from '../../src/lib/platform/link-schemes';

export function originOf(url: string): string {
  const parsed = URL.parse(url);
  return parsed ? `${parsed.protocol}//${parsed.host}` : '';
}

export function openExternal(url: string): void {
  const parsed = URL.parse(url);
  if (!parsed || !['http:', 'https:', 'mailto:', 'tel:'].includes(parsed.protocol)) return;
  void shell.openExternal(url).catch((error: unknown) => {
    console.warn('[sable links] Could not open external link', error);
  });
}

/** For a link the user confirmed in the page, so any scheme the OS can route is allowed. */
export async function openAppLink(url: unknown): Promise<void> {
  const parsed = typeof url === 'string' ? URL.parse(url) : null;
  if (!parsed || !isOpenableProtocol(parsed.protocol)) throw new Error('Link scheme not allowed');
  await shell.openExternal(parsed.href);
}

export function historyDirection(
  input: Pick<Electron.Input, 'key' | 'alt' | 'control' | 'meta' | 'shift'>,
  platform: NodeJS.Platform
): 'back' | 'forward' | null {
  if (input.shift || input.control) return null;
  const mac = platform === 'darwin';
  if (mac ? !input.meta || input.alt : !input.alt || input.meta) return null;
  if (input.key === (mac ? '[' : 'ArrowLeft')) return 'back';
  if (input.key === (mac ? ']' : 'ArrowRight')) return 'forward';
  return null;
}

/** macOS gets both from its application menu, which the other platforms do not have. */
export function windowShortcut(
  input: Pick<Electron.Input, 'key' | 'alt' | 'control' | 'meta' | 'shift'>,
  platform: NodeJS.Platform
): 'quit' | 'close' | null {
  if (platform === 'darwin') return null;
  if (!input.control || input.alt || input.meta || input.shift) return null;
  const key = input.key.toLowerCase();
  if (key === 'q') return 'quit';
  if (key === 'w') return 'close';
  return null;
}
