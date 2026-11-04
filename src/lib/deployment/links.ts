import { isTauri } from '@tauri-apps/api/core';
import { type as osType } from '@tauri-apps/plugin-os';

import type { RuntimeConfig } from '#lib/config/runtime-config.js';

import { deployment } from './deployment.js';

const SABLE_SOURCE_URL = 'https://git.sable.moe/SableClient/sable-next';
const SABLE_DONATE_URL = 'https://opencollective.com/sable';
const SABLE_SUPPORT_ROOM = '#general:sable.moe';
export const SABLE_PRIVACY_URL = 'https://sable.moe/privacy';
export const SABLE_UPDATE_MANIFEST_URL =
  'https://git.sable.moe/SableClient/sable-next/releases/download/latest/latest.json';

export type PolicyLink = { text: string; url: string };

export function communityFeatures(config: RuntimeConfig = deployment()): boolean {
  return !config.hideCommunityLinks;
}

function community<T>(value: T, config: RuntimeConfig): T | null {
  return communityFeatures(config) ? value : null;
}

export function sourceUrl(config: RuntimeConfig = deployment()): string | null {
  return community(SABLE_SOURCE_URL, config);
}

export function donateUrl(config: RuntimeConfig = deployment()): string | null {
  if (isTauri() && osType() === 'ios') return null;
  return community(SABLE_DONATE_URL, config);
}

export function supportRoom(config: RuntimeConfig = deployment()): string | null {
  return config.links.supportRoom ?? community(SABLE_SUPPORT_ROOM, config);
}

export function privacyUrl(config: RuntimeConfig = deployment()): string {
  return config.links.privacy ?? SABLE_PRIVACY_URL;
}

export function helpUrl(config: RuntimeConfig = deployment()): string | null {
  return config.links.help;
}

export function bugReportUrl(config: RuntimeConfig = deployment()): string | null {
  return config.links.bugReport;
}

export function termsLinks(config: RuntimeConfig = deployment()): readonly PolicyLink[] {
  return config.links.terms;
}
