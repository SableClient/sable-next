import { invoke, isTauri } from '@tauri-apps/api/core';

import { isAndroid } from './os.js';

const permissionNames = ['local-network', 'loopback-network', 'local-network-access'];

export class LocalNetworkBlockedError extends Error {
  override readonly name = 'LocalNetworkBlockedError';

  constructor(readonly host: string) {
    super(host);
  }
}

export function browserGatesCoreNetwork(): boolean {
  return !isTauri();
}

export async function localNetworkDenied(): Promise<boolean> {
  const permissions = globalThis.navigator.permissions as Permissions | undefined;
  if (permissions === undefined) return false;
  for (const name of permissionNames) {
    try {
      const status = await permissions.query({ name } as unknown as PermissionDescriptor);
      if (status.state === 'denied') return true;
    } catch {
      continue;
    }
  }
  return false;
}

export async function requestAndroidLocalNetwork(): Promise<boolean> {
  if (!isAndroid()) return false;
  try {
    const states = await invoke<Record<string, string>>('plugin:sable-push|request_permissions', {
      permissions: ['localNetwork'],
    });
    return states.localNetwork === 'granted';
  } catch (error) {
    console.warn('[sable auth] local network permission unavailable', error);
    return false;
  }
}
