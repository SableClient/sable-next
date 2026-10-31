import type { WebContents } from 'electron';
import { readFileSync } from 'node:fs';
import * as v from 'valibot';

type WebRtcIpPolicy = Parameters<WebContents['setWebRTCIPHandlingPolicy']>[0];

const WEBRTC_IP_POLICIES: readonly WebRtcIpPolicy[] = [
  'default',
  'default_public_and_private_interfaces',
  'default_public_interface_only',
  'disable_non_proxied_udp',
];

const DEFAULTS = {
  hardwareAcceleration: true,
  hardwareVideoAcceleration: true,
  smoothScrolling: true,
  webRtcIpPolicy: 'default',
  updateChannel: 'stable',
  customTitleBar: process.platform === 'win32',
  launchAtLogin: false,
  startMinimized: false,
} as const;

const SettingsSchema = v.object({
  hardwareAcceleration: v.fallback(v.boolean(), DEFAULTS.hardwareAcceleration),
  hardwareVideoAcceleration: v.fallback(v.boolean(), DEFAULTS.hardwareVideoAcceleration),
  smoothScrolling: v.fallback(v.boolean(), DEFAULTS.smoothScrolling),
  webRtcIpPolicy: v.fallback(v.picklist(WEBRTC_IP_POLICIES), DEFAULTS.webRtcIpPolicy),
  updateChannel: v.fallback(v.picklist(['stable', 'nightly']), DEFAULTS.updateChannel),
  customTitleBar: v.fallback(v.boolean(), DEFAULTS.customTitleBar),
  launchAtLogin: v.fallback(v.boolean(), DEFAULTS.launchAtLogin),
  startMinimized: v.fallback(v.boolean(), DEFAULTS.startMinimized),
});

export type Settings = v.InferOutput<typeof SettingsSchema>;

const parseSettings = v.parser(v.fallback(SettingsSchema, () => ({ ...DEFAULTS })));

export function sanitize(value: unknown): Settings {
  return parseSettings(value);
}

export function readSettings(path: string): Settings {
  try {
    return sanitize(JSON.parse(readFileSync(path, 'utf8')));
  } catch {
    return DEFAULTS;
  }
}
