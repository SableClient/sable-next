import type { NativeCallCapabilities } from '@sableclient/tauri-plugin-livekit-mobile';

import { isNativeMobile } from './os';

export function hasNativeCalls(): boolean {
  try {
    return isNativeMobile();
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

export type IncomingSystemCall = {
  callId: string;
  uuid: string;
  callerName: string;
  hasVideo: boolean;
  roomId: string;
};

export async function reportIncomingSystemCall(call: IncomingSystemCall): Promise<boolean> {
  const plugin = await loadNativeCalls();
  if (!plugin) return false;
  try {
    await plugin.reportIncomingCall(call);
    return true;
  } catch {
    return false;
  }
}

export async function endSystemCall(callId: string): Promise<boolean> {
  const plugin = await loadNativeCalls();
  if (!plugin) return false;
  try {
    await plugin.endSystemCall({ callId });
    return true;
  } catch {
    return false;
  }
}
