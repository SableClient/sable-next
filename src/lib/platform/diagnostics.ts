import { isTauri } from '@tauri-apps/api/core';
import { platform } from '@tauri-apps/plugin-os';

import { isElectron } from './electron.js';

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

const WEB_OS_NAMES: readonly (readonly [RegExp, string])[] = [
  [/Android/, 'Android'],
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Macintosh|Mac OS X/, 'macOS'],
  [/Windows/, 'Windows'],
  [/CrOS/, 'ChromeOS'],
  [/Linux|X11/, 'Linux'],
];

const WEB_BROWSER_NAMES: readonly (readonly [RegExp, string])[] = [
  [/Edg\//, 'Edge'],
  [/OPR\//, 'Opera'],
  [/Firefox\/|FxiOS\//, 'Firefox'],
  [/Chrome\/|CriOS\//, 'Chrome'],
  [/Safari\//, 'Safari'],
];

function webOsName(userAgent: string): string | undefined {
  return WEB_OS_NAMES.find(([pattern]) => pattern.test(userAgent))?.[1];
}

export function webDeviceLabel(userAgent: string): string {
  const os = webOsName(userAgent);
  const browser = WEB_BROWSER_NAMES.find(([pattern]) => pattern.test(userAgent))?.[1];
  if (browser && os) return `${browser} for ${os}`;
  return browser ?? os ?? 'Web';
}

interface HighEntropyValues {
  architecture?: string;
  bitness?: string;
}

async function webArchitecture(): Promise<string | undefined> {
  const data = (
    navigator as Navigator & {
      userAgentData?: { getHighEntropyValues: (hints: string[]) => Promise<HighEntropyValues> };
    }
  ).userAgentData;
  if (!data) return undefined;

  const values = await data
    .getHighEntropyValues(['architecture', 'bitness'])
    .catch((error: unknown) => {
      console.debug('[sable diagnostics] architecture unavailable', error);
      return undefined;
    });
  if (!values?.architecture) return undefined;
  return values.bitness ? `${values.architecture} ${values.bitness}-bit` : values.architecture;
}

export function webPlatformLabel(userAgent: string, architecture: string | undefined): string {
  const name = webOsName(userAgent) ?? 'unknown';
  return architecture === undefined ? name : `${name} (${architecture})`;
}

export async function describePlatform(): Promise<string> {
  if (isTauri()) {
    const { arch, platform, version } = await import('@tauri-apps/plugin-os');
    return `${platform()} ${version()} (${arch()})`;
  }
  return webPlatformLabel(navigator.userAgent, await webArchitecture());
}

const ISSUE_PLATFORMS: Record<string, string> = {
  linux: 'Linux',
  windows: 'Windows',
  macos: 'macOS',
  ios: 'iOS',
  android: 'Android',
};

export function issuePlatformOption(nativePlatform: string | undefined): string {
  return nativePlatform === undefined ? 'Web' : (ISSUE_PLATFORMS[nativePlatform] ?? '');
}

export function devicePlatformLabel(): string {
  if (isTauri()) {
    const native = platform();
    return ISSUE_PLATFORMS[native] ?? native;
  }
  if (isElectron()) return webOsName(navigator.userAgent) ?? 'Desktop';
  return webDeviceLabel(navigator.userAgent);
}

export async function issuePlatform(): Promise<string> {
  if (!isTauri()) return issuePlatformOption(undefined);
  const { platform } = await import('@tauri-apps/plugin-os');
  return issuePlatformOption(platform());
}
