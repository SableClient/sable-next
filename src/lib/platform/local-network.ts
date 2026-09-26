import { isTauri } from '@tauri-apps/api/core';

const permissionNames = ['local-network', 'loopback-network', 'local-network-access'];

export function browserGatesCoreNetwork(): boolean {
  return !isTauri();
}

async function localNetworkStates(): Promise<PermissionState[]> {
  const permissions = globalThis.navigator.permissions as Permissions | undefined;
  if (permissions === undefined) return [];
  const states: PermissionState[] = [];
  for (const name of permissionNames) {
    try {
      const status = await permissions.query({ name } as unknown as PermissionDescriptor);
      states.push(status.state);
    } catch {
      continue;
    }
  }
  return states;
}

export async function localNetworkDenied(): Promise<boolean> {
  return (await localNetworkStates()).includes('denied');
}

export async function mayHoldLocalNetworkGrant(): Promise<boolean> {
  const states = await localNetworkStates();
  return states.includes('granted') || !states.includes('denied');
}
