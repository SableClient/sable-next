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

const WEB_OS_NAMES: readonly (readonly [RegExp, string])[] = [
  [/Android/, 'Android'],
  [/iPhone|iPad|iPod/, 'iOS'],
  [/Macintosh|Mac OS X/, 'macOS'],
  [/Windows/, 'Windows'],
  [/CrOS/, 'ChromeOS'],
  [/Linux|X11/, 'Linux'],
];

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
    .catch(() => undefined);
  if (!values?.architecture) return undefined;
  return values.bitness ? `${values.architecture} ${values.bitness}-bit` : values.architecture;
}

export function webPlatformLabel(userAgent: string, architecture: string | undefined): string {
  const name = WEB_OS_NAMES.find(([pattern]) => pattern.test(userAgent))?.[1] ?? 'unknown';
  return architecture === undefined ? name : `${name} (${architecture})`;
}

export async function describePlatform(): Promise<string> {
  if (isTauri()) {
    const { arch, platform, version } = await import('@tauri-apps/plugin-os');
    return `${platform()} ${version()} (${arch()})`;
  }
  return webPlatformLabel(navigator.userAgent, await webArchitecture());
}
