import { isTauri } from '@tauri-apps/api/core';
import {
  checkPermissions,
  getCurrentPosition,
  requestPermissions,
} from '@tauri-apps/plugin-geolocation';

import { isNativeMobile } from './os';

export type Fix = { latitude: number; longitude: number };

export type FixResult =
  | { kind: 'fix'; fix: Fix }
  | { kind: 'denied' }
  | { kind: 'unavailable' }
  | { kind: 'unsupported' };

export function locates(): boolean {
  if (isTauri()) return isNativeMobile();
  return typeof navigator !== 'undefined' && 'geolocation' in navigator;
}

async function nativeFix(timeoutMs: number): Promise<FixResult> {
  try {
    let status = await checkPermissions();
    if (status.location === 'prompt' || status.location === 'prompt-with-rationale') {
      status = await requestPermissions(['location']);
    }
    if (status.location !== 'granted') return { kind: 'denied' };

    const { coords } = await getCurrentPosition({
      timeout: timeoutMs,
      enableHighAccuracy: false,
      maximumAge: 0,
    });
    return { kind: 'fix', fix: { latitude: coords.latitude, longitude: coords.longitude } };
  } catch (error) {
    console.debug('[sable location] the native fix failed', error);
    return { kind: 'unavailable' };
  }
}

function webFix(timeoutMs: number): Promise<FixResult> {
  return new Promise((resolve) => {
    navigator.geolocation.getCurrentPosition(
      ({ coords }) => {
        resolve({ kind: 'fix', fix: { latitude: coords.latitude, longitude: coords.longitude } });
      },
      (error) => {
        resolve({ kind: error.code === error.PERMISSION_DENIED ? 'denied' : 'unavailable' });
      },
      { timeout: timeoutMs, enableHighAccuracy: false }
    );
  });
}

export function currentFix(timeoutMs = 10_000): Promise<FixResult> {
  if (isNativeMobile()) return nativeFix(timeoutMs);
  if (!locates()) return Promise.resolve({ kind: 'unsupported' });

  return webFix(timeoutMs);
}
