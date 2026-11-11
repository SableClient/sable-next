import { afterEach, describe, expect, it, vi } from 'vitest';

import type { PersonaView } from '#src/generated/protocol';

import {
  matchImported,
  fetchPluralkitMembers,
  parsePluralkitExport,
  personaFromPluralkit,
  systemIdFromInput,
} from './pluralkit';

const member = {
  id: 'abcde',
  uuid: '00000000-0000-0000-0000-000000000001',
  name: 'kris',
  display_name: 'Kris',
  color: '7f5af0',
  pronouns: 'they/them, she/her',
  avatar_url: 'https://cdn.pluralkit.me/kris.png',
  description: 'a member',
  proxy_tags: [
    { prefix: 'k:', suffix: null },
    { prefix: null, suffix: null },
  ],
};

afterEach(() => vi.unstubAllGlobals());

describe('systemIdFromInput', () => {
  it('takes a bare id', () => {
    expect(systemIdFromInput('  abcde ')).toBe('abcde');
  });

  it('takes an API url', () => {
    expect(systemIdFromInput('https://api.pluralkit.me/v2/systems/abcde/members')).toBe('abcde');
  });

  it('drops a pk; prefix', () => {
    expect(systemIdFromInput('pk;abcde')).toBe('abcde');
  });
});

describe('parsePluralkitExport', () => {
  it('reads the members of a pk;export file', () => {
    const exported = { version: 2, id: 'sysid', name: 'System', members: [member], groups: [] };
    expect(parsePluralkitExport(JSON.stringify(exported))).toEqual([member]);
  });

  it('reads a bare member list', () => {
    expect(parsePluralkitExport(JSON.stringify([member]))).toEqual([member]);
  });

  it('keeps additional member and proxy-tag fields', () => {
    const extended = {
      ...member,
      created: '2026-01-01',
      proxy_tags: [{ prefix: 'k:', custom: true }],
    };
    expect(parsePluralkitExport(JSON.stringify([extended]))).toEqual([extended]);
  });

  it.each([
    { display_name: 42 },
    { pronouns: ['they/them'] },
    { proxy_tags: {} },
    { proxy_tags: [null] },
    { proxy_tags: [{ prefix: 42 }] },
  ])('rejects malformed optional fields before persona conversion: %j', (fields) => {
    expect(() => parsePluralkitExport(JSON.stringify([{ ...member, ...fields }]))).toThrow(
      'not a PluralKit member list'
    );
  });

  it.each([
    ['malformed JSON', '{'],
    ['an object without members', JSON.stringify({ id: 'sysid' })],
    ['a member without a name', JSON.stringify([{ id: 'abcde' }])],
    ['a member with a numeric id', JSON.stringify({ members: [{ id: 1, name: 'kris' }] })],
    ['a null member', JSON.stringify([null])],
    ['a string', JSON.stringify('kris')],
  ])('rejects %s', (_, text) => {
    expect(() => parsePluralkitExport(text)).toThrow();
  });
});

describe('fetchPluralkitMembers', () => {
  it('validates fetched members and keeps authenticated requests', async () => {
    const fetch = vi.fn().mockResolvedValue(Response.json([member]));
    vi.stubGlobal('fetch', fetch);
    expect(await fetchPluralkitMembers('sysid', 'token')).toEqual([member]);
    expect(fetch).toHaveBeenCalledWith('https://api.pluralkit.me/v2/systems/sysid/members', {
      headers: { Authorization: 'token' },
    });
  });

  it('rejects malformed API members before import', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue(Response.json([{ ...member, proxy_tags: [{ suffix: [] }] }]))
    );
    await expect(fetchPluralkitMembers('sysid')).rejects.toThrow(
      'pluralkit returned an invalid member list'
    );
  });
});

describe('personaFromPluralkit', () => {
  it('maps the member onto a persona', () => {
    const persona = personaFromPluralkit('kris', member, 'mxc://example.org/kris');

    expect(persona.id).toBe('kris');
    expect(persona.display_name).toBe('Kris');
    expect(persona.avatar_url).toBe('mxc://example.org/kris');
    expect(persona.pronouns).toEqual([
      { summary: 'they/them', language: null },
      { summary: 'she/her', language: null },
    ]);
    expect(persona.color_on_light).toBe('#7f5af0');
    expect(persona.color_on_dark).toBe('#7f5af0');
    expect(persona.triggers).toEqual([
      { prefix: 'k:', suffix: null, keep_trigger: false, alternate_avatar_id: null },
    ]);
    expect(persona.pluralkit?.avatar_url).toBe('https://cdn.pluralkit.me/kris.png');
  });

  it('falls back to the name when there is no display name', () => {
    const persona = personaFromPluralkit('kris', { ...member, display_name: '  ' }, null);
    expect(persona.display_name).toBe('kris');
  });

  it('drops a colour PluralKit did not set', () => {
    const persona = personaFromPluralkit('kris', { ...member, color: null }, null);
    expect(persona.color_on_light).toBeNull();
  });
});

describe('personaFromPluralkit on update', () => {
  it('keeps the fields PluralKit does not provide', () => {
    const existing: PersonaView = {
      ...personaFromPluralkit('kris', member, null),
      last_used: 42,
      alternate_avatars: [{ id: 'alt', url: 'mxc://example.org/alt' } as never],
      biography: 'bio',
      banner_url: 'mxc://example.org/banner',
      is_animal: 'cat',
      has_animal: 'dog',
      animal_need: 'food',
      sort_flags: { pinned: true } as never,
      triggers: [{ prefix: 'k:', suffix: null, keep_trigger: true, alternate_avatar_id: 'alt' }],
    };

    const persona = personaFromPluralkit('kris', member, null, {}, existing);

    expect(persona).toMatchObject({
      last_used: 42,
      alternate_avatars: existing.alternate_avatars,
      biography: 'bio',
      banner_url: 'mxc://example.org/banner',
      is_animal: 'cat',
      has_animal: 'dog',
      animal_need: 'food',
      sort_flags: existing.sort_flags,
    });
    expect(persona.triggers).toEqual(existing.triggers);
  });
});

describe('matchImported', () => {
  const imported = personaFromPluralkit('kris', member, null);
  const handwritten: PersonaView = { ...imported, id: 'other', pluralkit: null };

  it('matches on the PluralKit uuid even after a rename', () => {
    const renamed = { ...member, name: 'kristopher' };
    expect(matchImported([handwritten, imported], renamed)?.id).toBe('kris');
  });

  it('falls back to the short id when there is no uuid', () => {
    expect(matchImported([imported], { ...member, uuid: null })?.id).toBe('kris');
  });

  it('never matches a persona nobody imported', () => {
    expect(matchImported([handwritten], member)).toBeUndefined();
  });
});
describe('pluralkitPronounExtraction', () => {
  it('reads several groups and less common forms from the display name', () => {
    const persona = personaFromPluralkit(
      'kris',
      { ...member, display_name: 'Kris (it/its) [ey/em/eir/eirs]', pronouns: undefined },
      null,
      { extractPronouns: true }
    );

    expect(persona.display_name).toBe('Kris');
    expect(persona.pronouns).toEqual([
      { summary: 'it/its', language: null },
      { summary: 'ey/em/eir/eirs', language: null },
    ]);
  });

  it('name pronouns override stored pronouns', () => {
    const persona = personaFromPluralkit(
      'kris',
      { ...member, display_name: 'Kris (they/she)', pronouns: 'evil/bad' },
      'mxc://example.org/kris',
      { extractPronouns: true }
    );

    expect(persona.display_name).toBe('Kris');
    expect(persona.pronouns).toEqual([{ summary: 'they/she', language: null }]);
  });

  it('no pronoun extraction when disabled', () => {
    const persona = personaFromPluralkit(
      'kris',
      { ...member, display_name: 'Kris (they/she)', pronouns: undefined },
      'mxc://example.org/kris',
      { extractPronouns: false }
    );

    expect(persona.display_name).toBe('Kris (they/she)');
    expect(persona.pronouns).toEqual([]);
  });
});
