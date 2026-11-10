import { isRecord } from '#lib/guards.js';

export interface BridgePart {
  name: string;
  url: string | null;
  avatar: string | null;
}

export interface BridgeInfo {
  key: string;
  protocol: BridgePart;
  network: BridgePart | null;
  channel: BridgePart | null;
  bot: string | null;
  creator: string | null;
}

export const BRIDGE_EVENT_TYPES = ['m.bridge', 'uk.half-shot.bridge'] as const;

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
}

function link(value: unknown): string | null {
  const url = text(value);
  if (url === null || !URL.canParse(url)) return null;
  return ['http:', 'https:'].includes(new URL(url).protocol) ? url : null;
}

function part(value: unknown): BridgePart | null {
  if (!isRecord(value)) return null;
  const { id, displayname, avatar_url, external_url } = value;
  const name = text(displayname) ?? text(id);
  if (name === null) return null;
  const avatar = text(avatar_url);
  return { name, url: link(external_url), avatar: avatar?.startsWith('mxc://') ? avatar : null };
}

/** Events in `BRIDGE_EVENT_TYPES` order, so a bridge sending both types is listed once. */
export function parseBridgeEvents(events: readonly unknown[]): BridgeInfo[] {
  const bridges = new Map<string, BridgeInfo>();
  for (const event of events) {
    if (!isRecord(event)) continue;
    const { state_key, content } = event;
    if (typeof state_key !== 'string' || bridges.has(state_key) || !isRecord(content)) continue;
    const protocol = part(content.protocol);
    if (protocol === null) continue;
    bridges.set(state_key, {
      key: state_key,
      protocol,
      network: part(content.network),
      channel: part(content.channel),
      bot: text(content.bridgebot),
      creator: text(content.creator),
    });
  }
  return [...bridges.values()];
}
