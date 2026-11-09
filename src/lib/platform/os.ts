import { isTauri } from '@tauri-apps/api/core';
import { type as osType } from '@tauri-apps/plugin-os';

type OsType = ReturnType<typeof osType>;

let reportedFallback = false;

function osFromUserAgent(): OsType | null {
  const agent = navigator.userAgent;
  if (/Android/i.test(agent)) return 'android';
  if (/iPhone|iPad|iPod/.test(agent) || (/Macintosh/.test(agent) && navigator.maxTouchPoints > 1))
    return 'ios';
  return null;
}

/** The OS plugin's value comes from an init script, so a page loaded without it is read from the user agent. */
function nativeOs(): OsType | null {
  if (!isTauri()) return null;
  try {
    return osType();
  } catch (error) {
    const fallback = osFromUserAgent();
    if (!reportedFallback) {
      reportedFallback = true;
      console.error(
        '[sable platform] OS plugin unavailable, using the user agent',
        fallback,
        error
      );
    }
    return fallback;
  }
}

export function isNativeMobile(): boolean {
  const os = nativeOs();
  return os === 'ios' || os === 'android';
}

export function isAndroid(): boolean {
  return nativeOs() === 'android';
}

export function isIos(): boolean {
  return nativeOs() === 'ios';
}

export function supportsKeyboardShortcuts(): boolean {
  if (isNativeMobile()) return false;
  return typeof matchMedia !== 'function' || matchMedia('(any-pointer: fine)').matches;
}

export function supportsTouch(): boolean {
  if (isNativeMobile()) return true;
  return typeof matchMedia === 'function' && matchMedia('(any-pointer: coarse)').matches;
}
