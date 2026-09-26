import { isTauri } from '@tauri-apps/api/core';

const permissionNames = ['local-network', 'loopback-network', 'local-network-access'];

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
