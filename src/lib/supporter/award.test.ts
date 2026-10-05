import { describe, expect, test } from 'vitest';

import { badgeFor, canonicalJson, parseAwards, userHash, verifyAward } from './award.js';
import { EXPIRED, FIXTURE_KEYS, FIXTURE_USER, PERMANENT, VALID } from './fixtures.js';

const NOW = Date.UTC(2026, 9, 4);

describe('canonicalJson', () => {
  test('sorts keys and drops whitespace', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, 1], c: 'x' } })).toBe(
      '{"a":{"c":"x","d":[2,1]},"b":1}'
    );
  });
});

describe('userHash', () => {
  test('matches the service hash of the account', async () => {
    expect(await userHash(FIXTURE_USER)).toBe(VALID.signed.user_id_hash);
  });
});

describe('verifyAward', () => {
  test('accepts an award signed by the Go service', async () => {
    expect(await verifyAward(VALID, FIXTURE_USER, FIXTURE_KEYS, NOW)).toBe(true);
    expect(await verifyAward(PERMANENT, FIXTURE_USER, FIXTURE_KEYS, NOW)).toBe(true);
  });

  test('rejects an expired award', async () => {
    expect(await verifyAward(EXPIRED, FIXTURE_USER, FIXTURE_KEYS, NOW)).toBe(false);
  });

  test('rejects an award copied onto another account', async () => {
    expect(await verifyAward(VALID, '@mallory:example.org', FIXTURE_KEYS, NOW)).toBe(false);
  });

  test('rejects a tampered award', async () => {
    const forged = structuredClone(VALID);
    forged.signed.content.body = 'Founder';
    expect(await verifyAward(forged, FIXTURE_USER, FIXTURE_KEYS, NOW)).toBe(false);

    const extended = structuredClone(VALID);
    extended.signed.expires_at = 9999999999;
    expect(await verifyAward(extended, FIXTURE_USER, FIXTURE_KEYS, NOW)).toBe(false);
  });

  test('rejects a signature from a key that is not pinned', async () => {
    expect(await verifyAward(VALID, FIXTURE_USER, {}, NOW)).toBe(false);
    expect(await verifyAward(VALID, FIXTURE_USER, { '2': FIXTURE_KEYS['1'] }, NOW)).toBe(false);
    const other = { '1': 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' };
    expect(await verifyAward(VALID, FIXTURE_USER, other, NOW)).toBe(false);
  });

  test('survives a JSON round trip through a profile field', async () => {
    const [award] = parseAwards(JSON.stringify([VALID]));
    expect(award).toBeDefined();
    expect(await verifyAward(award, FIXTURE_USER, FIXTURE_KEYS, NOW)).toBe(true);
  });
});

describe('parseAwards', () => {
  test('ignores anything that is not a list of awards', () => {
    expect(parseAwards(null)).toEqual([]);
    expect(parseAwards('not json')).toEqual([]);
    expect(parseAwards('{"signed":{}}')).toEqual([]);
    expect(parseAwards(JSON.stringify([{ signed: {}, signatures: {} }, VALID]))).toEqual([VALID]);
  });
});

describe('badgeFor', () => {
  test('returns the label of a valid award', async () => {
    expect(await badgeFor(JSON.stringify([VALID]), FIXTURE_USER, FIXTURE_KEYS, NOW)).toEqual({
      label: 'Donor',
      tier: null,
      expiresAt: 4102444800,
    });
  });

  test('returns null when nothing verifies', async () => {
    expect(await badgeFor(JSON.stringify([EXPIRED]), FIXTURE_USER, FIXTURE_KEYS, NOW)).toBeNull();
    expect(await badgeFor(null, FIXTURE_USER, FIXTURE_KEYS, NOW)).toBeNull();
  });

  test('prefers the award that lasts longest, and a permanent one over any', async () => {
    const raw = JSON.stringify([VALID, PERMANENT, EXPIRED]);
    expect((await badgeFor(raw, FIXTURE_USER, FIXTURE_KEYS, NOW))?.expiresAt).toBeNull();
  });

  test('prefers a ranked tier over a longer-lived plain award', async () => {
    const { privateKey, publicKey } = await crypto.subtle.generateKey('Ed25519', true, [
      'sign',
      'verify',
    ]);
    const keys = {
      '1': btoa(
        String.fromCharCode(...new Uint8Array(await crypto.subtle.exportKey('raw', publicKey)))
      ),
    };
    const sign = async (content: { body: string; tier?: string }, expires_at?: number) => {
      const signed = {
        id: content.body,
        sender: '@awards:sable.moe',
        user_id_hash: await userHash(FIXTURE_USER),
        content,
        ...(expires_at ? { expires_at } : {}),
      };
      const signature = await crypto.subtle.sign(
        'Ed25519',
        privateKey,
        new TextEncoder().encode(canonicalJson(signed))
      );
      return {
        signed,
        signatures: { '1': btoa(String.fromCharCode(...new Uint8Array(signature))) },
      };
    };
    const raw = JSON.stringify([
      await sign({ body: 'Donor' }),
      await sign({ body: 'CEO of Sable', tier: 'ceo' }, 4102444800),
    ]);
    expect(await badgeFor(raw, FIXTURE_USER, keys, NOW)).toEqual({
      label: 'CEO of Sable',
      tier: 'ceo',
      expiresAt: 4102444800,
    });
  });
});
