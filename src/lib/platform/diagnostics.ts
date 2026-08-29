import { isTauri } from '@tauri-apps/api/core';

export interface DiagnosticsSystemInfo {
  appVersion: string;
  platform: string;
  osVersion: string;
  userAgent: string;
}

export async function collectSystemInfo(): Promise<DiagnosticsSystemInfo> {
  if (!isTauri()) {
    return { appVersion: '', platform: 'web', osVersion: '', userAgent: navigator.userAgent };
  }

  const [{ type, version }, { getVersion }] = await Promise.all([
    import('@tauri-apps/plugin-os'),
    import('@tauri-apps/api/app'),
  ]);

  return {
    appVersion: await getVersion().catch(() => ''),
    platform: type(),
    osVersion: version(),
    userAgent: navigator.userAgent,
  };
}
