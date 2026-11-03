import type { RuntimeConfig } from '#lib/config/runtime-config.js';

import { devicePlatformLabel } from '#lib/platform/diagnostics.js';
import { isNightlyBuild } from '#lib/platform/build-channel.js';

import { appName } from './brand.js';
import { deployment } from './deployment.js';

export function ssoRedirect(
  config: RuntimeConfig = deployment()
): 'immediate' | 'loginPage' | null {
  return config.auth.ssoRedirect;
}

export function registrationEnabled(config: RuntimeConfig = deployment()): boolean {
  return !config.auth.disableRegistration;
}

export function logoutRedirectUrl(config: RuntimeConfig = deployment()): string | null {
  return config.auth.logoutRedirectUrl;
}

export function deviceDisplayName(config: RuntimeConfig = deployment()): string {
  const name = config.auth.deviceDisplayName ?? appName(config);
  return `${name}${isNightlyBuild() ? ' (Nightly)' : ''} on ${devicePlatformLabel()}`;
}
