import type { RuntimeConfig } from '#lib/config/runtime-config.js';

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
  return config.auth.deviceDisplayName ?? appName(config);
}
