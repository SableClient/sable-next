import { describe, expect, it } from 'vitest';

import type { PersonaView } from '#src/generated/PersonaView';

import { matchImported, personaFromPluralkit, systemIdFromInput } from './pluralkit';

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

describe('personaFromPluralkit', () => {
  it('maps the member onto a persona', () => {
    const persona = personaFromPluralkit(member, 'mxc://example.org/kris');

    expect(persona.id).toBe('kris');
    expect(persona.display_name).toBe('Kris');
    expect(persona.avatar_url).toBe('mxc://example.org/kris');
    expect(persona.pronouns).toEqual([
      { summary: 'they/them', language: null },
      { summary: 'she/her', language: null },
    ]);
    expect(persona.color_on_light).toBe('#7f5af0');
    expect(persona.color_on_dark).toBe('#7f5af0');
    expect(persona.triggers).toEqual([{ prefix: 'k:', suffix: null, keep_trigger: false }]);
    expect(persona.pluralkit?.avatar_url).toBe('https://cdn.pluralkit.me/kris.png');
  });

  it('falls back to the name when there is no display name', () => {
    const persona = personaFromPluralkit({ ...member, display_name: '  ' }, null);
    expect(persona.display_name).toBe('kris');
  });

  it('drops a colour PluralKit did not set', () => {
    const persona = personaFromPluralkit({ ...member, color: null }, null);
    expect(persona.color_on_light).toBeNull();
  });
});

describe('matchImported', () => {
  const imported = personaFromPluralkit(member, null);
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
