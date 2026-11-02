import { shell } from 'electron';

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
