import { invoke, isTauri } from '@tauri-apps/api/core';

import { isAndroid } from './os.js';

const permissionNames = ['local-network', 'loopback-network', 'local-network-access'];

export class LocalNetworkBlockedError extends Error {
  override readonly name = 'LocalNetworkBlockedError';

  constructor(readonly host: string) {
    super(host);
  }
}

const privateRanges = [
  /^10\./,
  /^127\./,
  /^169\.254\./,
  /^172\.(1[6-9]|2\d|3[01])\./,
  /^192\.168\./,
  /^\[(::1|f[cd][0-9a-f]{2}:.*|fe[89ab][0-9a-f]:.*)\]$/i,
];

export function isLocalNetworkHost(hostname: string): boolean {
  const host = hostname.toLowerCase();
  return (
    host === 'localhost' ||
    host.endsWith('.localhost') ||
    host.endsWith('.local') ||
    privateRanges.some((range) => range.test(host))
  );
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

let askedAndroid = false;

// The request opens a system activity even with nothing to ask, which closes the keyboard.
export async function requestAndroidLocalNetwork(): Promise<boolean> {
  if (!isAndroid() || askedAndroid) return false;
  try {
    const current = await invoke<Record<string, string>>('plugin:sable-push|check_permissions');
    if (!current.localNetwork.startsWith('prompt')) return false;
    askedAndroid = true;
    const states = await invoke<Record<string, string>>('plugin:sable-push|request_permissions', {
      permissions: ['localNetwork'],
    });
    return states.localNetwork === 'granted';
  } catch (error) {
    console.warn('[sable auth] local network permission unavailable', error);
    return false;
  }
}

export async function probeFromPage(url: URL, init: RequestInit): Promise<void> {
  const probe = () => fetch(url, init);
  await probe().catch(async (error: unknown) => {
    if (!(await requestAndroidLocalNetwork())) throw error;
    return probe();
  });
}

export async function withLocalNetworkAccess(
  serviceUrl: string,
  connect: () => Promise<void>
): Promise<void> {
  try {
    await connect();
  } catch (error) {
    const origin = new URL(serviceUrl.replace(/^ws/, 'http'));
    if (!isLocalNetworkHost(origin.hostname)) throw error;
    if (isAndroid()) {
      if (!(await requestAndroidLocalNetwork())) throw error;
      return connect();
    }
    if (!browserGatesCoreNetwork()) throw error;
    try {
      await probeFromPage(origin, { mode: 'no-cors' });
    } catch {
      throw new LocalNetworkBlockedError(origin.hostname);
    }
    await connect();
  }
}
