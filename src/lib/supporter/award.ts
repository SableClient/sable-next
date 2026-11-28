import { stringify } from 'safe-stable-stringify';
import { base64ToUint8Array, uint8ArrayToHex } from 'uint8array-extras';

import { truncateGraphemes } from '#lib/graphemes.js';
import { isRecord } from '#lib/guards.js';

export interface Award {
  signed: {
    id: string;
    sender: string;
    user_id_hash: string;
    expires_at?: number;
    content: { body: string; tier?: string };
  };
  signatures: Record<string, string>;
}

export interface SupporterBadgeData {
  label: string;
  tier: string | null;
  expiresAt: number | null;
}

const TIER_RANK: Readonly<Record<string, number>> = { ceo: 1 };

function tierRank(tier: string | null): number {
  return (tier && TIER_RANK[tier]) || 0;
}

const MAX_LABEL_CHARS = 24;

function isAward(value: unknown): value is Award {
  if (!isRecord(value) || !isRecord(value.signed) || !isRecord(value.signatures)) return false;
  const { id, user_id_hash, content, expires_at } = value.signed;
  return (
    typeof id === 'string' &&
    typeof user_id_hash === 'string' &&
    isRecord(content) &&
    typeof content.body === 'string' &&
    (content.tier === undefined || typeof content.tier === 'string') &&
    (expires_at === undefined || typeof expires_at === 'number') &&
    Object.values(value.signatures).every((signature) => typeof signature === 'string')
  );
}

export function parseAwards(raw: string | null): Award[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter(isAward) : [];
  } catch {
    return [];
  }
}

export function canonicalJson(value: unknown): string {
  return stringify(value) ?? '';
}

export async function userHash(userId: string): Promise<string> {
  return uint8ArrayToHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(userId)));
}

const importedKeys = new Map<string, Promise<CryptoKey>>();

function importKey(encoded: string): Promise<CryptoKey> {
  let key = importedKeys.get(encoded);
  if (!key) {
    key = crypto.subtle.importKey('raw', base64ToUint8Array(encoded), 'Ed25519', false, ['verify']);
    importedKeys.set(encoded, key);
  }
  return key;
}

async function signatureHolds(
  award: Award,
  keys: Readonly<Record<string, string>>
): Promise<boolean> {
  const data = new TextEncoder().encode(canonicalJson(award.signed));
  for (const [keyId, signature] of Object.entries(award.signatures)) {
    const encoded = keys[keyId];
    if (!encoded) continue;
    try {
      if (
        await crypto.subtle.verify(
          'Ed25519',
          await importKey(encoded),
          base64ToUint8Array(signature),
          data
        )
      ) {
        return true;
      }
    } catch {
      continue;
    }
  }
  return false;
}

export function isExpired(award: Award, now: number): boolean {
  const { expires_at } = award.signed;
  return expires_at !== undefined && expires_at * 1000 <= now;
}

export async function verifyAward(
  award: Award,
  userId: string,
  keys: Readonly<Record<string, string>>,
  now: number = Date.now()
): Promise<boolean> {
  if (isExpired(award, now)) return false;
  if (award.signed.user_id_hash !== (await userHash(userId))) return false;
  return signatureHolds(award, keys);
}

export async function badgeFor(
  raw: string | null,
  userId: string,
  keys: Readonly<Record<string, string>>,
  now: number = Date.now()
): Promise<SupporterBadgeData | null> {
  let best: SupporterBadgeData | null = null;
  for (const award of parseAwards(raw)) {
    if (!(await verifyAward(award, userId, keys, now))) continue;
    const expiresAt = award.signed.expires_at ?? null;
    const tier = award.signed.content.tier ?? null;
    if (best) {
      const rank = tierRank(tier);
      const bestRank = tierRank(best.tier);
      if (rank < bestRank) continue;
      if (
        rank === bestRank &&
        (best.expiresAt === null || (expiresAt !== null && expiresAt <= best.expiresAt))
      ) {
        continue;
      }
    }
    best = {
      label: truncateGraphemes(award.signed.content.body.trim(), MAX_LABEL_CHARS),
      tier,
      expiresAt,
    };
  }
  return best && best.label ? best : null;
}
