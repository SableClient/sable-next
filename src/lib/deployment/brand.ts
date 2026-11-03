import type { RuntimeConfig } from '#lib/config/runtime-config.js';

import { deployment } from './deployment.js';

export const DEFAULT_APP_NAME = 'Sable';

export function appName(config: RuntimeConfig = deployment()): string {
  return config.branding.appName ?? DEFAULT_APP_NAME;
}

export function logoUrl(config: RuntimeConfig = deployment()): string | null {
  return config.branding.logoUrl;
}

export function faviconUrl(config: RuntimeConfig = deployment()): string | null {
  return config.branding.faviconUrl;
}

export function themeUrl(config: RuntimeConfig = deployment()): string | null {
  return config.branding.themeUrl;
}

export function pageTitle(title: string, config: RuntimeConfig = deployment()): string {
  const name = appName(config);
  return title && title !== name ? `${title} - ${name}` : name;
}
