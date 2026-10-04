import { isRecord } from '#lib/guards.js';

export interface Award {
  signed: {
    id: string;
    sender: string;
    user_id_hash: string;
    expires_at?: number;
    content: { body: string };
  };
  signatures: Record<string, string>;
}

export interface SupporterBadgeData {
  label: string;
  expiresAt: number | null;
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
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (isRecord(value)) {
    const entries = Object.keys(value)
      .slice()
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function hex(bytes: ArrayBuffer): string {
  return Array.from(new Uint8Array(bytes), (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function decodeBase64(value: string): Uint8Array<ArrayBuffer> {
  const binary = atob(value.replaceAll('-', '+').replaceAll('_', '/'));
  return Uint8Array.from(binary, (char) => char.charCodeAt(0));
}

export async function userHash(userId: string): Promise<string> {
  return hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(userId)));
}

const importedKeys = new Map<string, Promise<CryptoKey>>();

function importKey(encoded: string): Promise<CryptoKey> {
  let key = importedKeys.get(encoded);
  if (!key) {
    key = crypto.subtle.importKey('raw', decodeBase64(encoded), 'Ed25519', false, ['verify']);
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
          decodeBase64(signature),
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
    if (best && (best.expiresAt === null || (expiresAt !== null && expiresAt <= best.expiresAt))) {
      continue;
    }
    best = { label: award.signed.content.body.trim().slice(0, MAX_LABEL_CHARS), expiresAt };
  }
  return best && best.label ? best : null;
}
