import { describe, expect, it } from 'vitest';

import { backupFileName, backupJson, CATALOG_EVENT, parseBackup } from './backup';

const catalog = { profiles: [{ id: 'kris', displayname: 'Kris' }], 'x.extra': true };

describe('backupJson', () => {
  it('keys the raw content by the catalog event type', () => {
    expect(JSON.parse(backupJson(catalog))).toEqual({
      'fi.mau.msc4461.per_message_profiles.v3': catalog,
    });
  });

  it('round-trips through parseBackup', () => {
    expect(parseBackup(backupJson(catalog))).toEqual(catalog);
  });
});

describe('parseBackup', () => {
  it.each([
    ['a file without the v3 key', { 'fi.mau.msc4461.per_message_profiles.v2': catalog }],
    ['a catalog without profiles', { [CATALOG_EVENT]: {} }],
    ['a null catalog', { [CATALOG_EVENT]: null }],
    ['an array catalog', { [CATALOG_EVENT]: [] }],
    ['a bare catalog', catalog],
    ['an array', [catalog]],
  ])('rejects %s', (_, value) => {
    expect(() => parseBackup(JSON.stringify(value))).toThrow();
  });

  it('rejects malformed JSON', () => {
    expect(() => parseBackup('{')).toThrow();
  });
});

describe('backupFileName', () => {
  it('dates the file', () => {
    expect(backupFileName(new Date('2026-09-23T12:00:00Z'))).toBe('sable-profiles-2026-09-23.json');
  });
});
