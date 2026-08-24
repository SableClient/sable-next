import { isTauri } from '@tauri-apps/api/core';
import { type as osType } from '@tauri-apps/plugin-os';
import type { NativeCallCapabilities } from '@sableclient/tauri-plugin-livekit-mobile';

export function hasNativeCalls(): boolean {
  if (!isTauri()) return false;
  try {
    const platform = osType();
    return platform === 'android' || platform === 'ios';
  } catch {
    return false;
  }
}

export async function nativeCallCapabilities(): Promise<NativeCallCapabilities | null> {
  if (!hasNativeCalls()) return null;
  try {
    const plugin = await import('@sableclient/tauri-plugin-livekit-mobile');
    return await plugin.getNativeCallCapabilities();
  } catch {
    return null;
  }
}

export const loadNativeCalls = async (): Promise<
  typeof import('@sableclient/tauri-plugin-livekit-mobile') | null
> => (hasNativeCalls() ? import('@sableclient/tauri-plugin-livekit-mobile') : null);
