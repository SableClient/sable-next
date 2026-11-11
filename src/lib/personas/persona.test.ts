// @vitest-environment happy-dom

import { describe, expect, it } from 'vitest';

import type { PersonaTriggerView, PersonaView } from '#src/generated/protocol';

import {
  alternateAvatarId,
  filterPersonas,
  projectPersona,
  reorderPersonas,
  resolvePersona,
  resolveProxy,
  stripProxyHtml,
  testPersona,
} from './persona';

function persona(id: string, triggers: PersonaTriggerView[] = []): PersonaView {
  return {
    ...testPersona,
    id,
    display_name: id,
    triggers,
  };
}

function trigger(
  prefix: string | null,
  suffix: string | null = null,
  keep = false
): PersonaTriggerView {
  return { prefix, suffix, keep_trigger: keep, alternate_avatar_id: null };
}

describe('resolveProxy', () => {
  it('strips a prefix trigger', () => {
    const kris = persona('Kris', [trigger('k:')]);
    expect(resolveProxy([kris], 'k:hello')).toEqual({
      persona: kris,
      body: 'hello',
      trigger: trigger('k:'),
    });
  });

  it('strips both ends of a circumfix', () => {
    const kris = persona('Kris', [trigger('[', ']')]);
    expect(resolveProxy([kris], '[hello]')?.body).toBe('hello');
  });

  it.each([
    [trigger('k:'), 'k: \thello\n ', 'hello'],
    [trigger(null, '-k'), ' \thello\n -k', 'hello'],
    [trigger('[', ']'), '[ \thello\n ]', 'hello'],
    [trigger('[', ']'), '[ \t\n ]', ''],
    [trigger('k:', null, true), 'k: hello ', 'k: hello '],
  ])('trims whitespace exposed by stripping %j', (wrapper, body, expected) => {
    expect(resolveProxy([persona('Kris', [wrapper])], body)?.body).toBe(expected);
  });

  it('keeps the trigger when the persona asks it to', () => {
    const kris = persona('Kris', [trigger('k:', null, true)]);
    expect(resolveProxy([kris], 'k:hello')?.body).toBe('k:hello');
  });

  it('takes the first matching persona in catalog order', () => {
    const first = persona('First', [trigger('[', ']')]);
    const second = persona('Second', [trigger('[')]);
    expect(resolveProxy([first, second], '[hello]')?.persona.id).toBe('First');
  });

  it('ignores a trigger with neither end, which would match everything', () => {
    expect(resolveProxy([persona('Kris', [trigger(null, null)])], 'hello')).toBeUndefined();
  });

  it('does not match a body shorter than its two ends together', () => {
    const kris = persona('Kris', [trigger('ab', 'cd')]);
    expect(resolveProxy([kris], 'abd')).toBeUndefined();
  });

  it('returns nothing when no trigger matches', () => {
    expect(resolveProxy([persona('Kris', [trigger('k:')])], 'hello')).toBeUndefined();
  });
});

describe('reorderPersonas', () => {
  it('moves one profile while preserving the rest', () => {
    const profiles = [persona('A'), persona('B'), persona('C')];
    expect(reorderPersonas(profiles, 2, 0).map(({ id }) => id)).toEqual(['C', 'A', 'B']);
  });
});

describe('filterPersonas', () => {
  const profiles = [persona('Kestrel'), persona('wren'), persona('Rook')];

  it('matches names and ids ignoring case and surrounding spaces', () => {
    expect(filterPersonas(profiles, '  WR ').map(({ id }) => id)).toEqual(['wren']);
    expect(filterPersonas(profiles, 'r').map(({ id }) => id)).toEqual(['Kestrel', 'wren', 'Rook']);
  });

  it('keeps every profile for an empty query', () => {
    expect(filterPersonas(profiles, ' ')).toEqual(profiles);
  });
});

describe('stripProxyHtml', () => {
  it('retains formatting after removing a prefix trigger', () => {
    expect(stripProxyHtml('k:<code>const answer = 42</code>', trigger('k:'))).toBe(
      '<code>const answer = 42</code>'
    );
  });

  it('retains formatting after removing a circumfix trigger', () => {
    expect(stripProxyHtml('[<em>test</em>]', trigger('[', ']'))).toBe('<em>test</em>');
  });

  it('trims exposed whitespace across formatted text nodes', () => {
    expect(stripProxyHtml('<p>[ <em> hello </em> ]</p>', trigger('[', ']'))).toBe(
      '<p><em>hello</em></p>'
    );
  });

  it('keeps the space before an emote at the end of the message', () => {
    expect(stripProxyHtml('k: hello <img data-mx-emoticon alt=":a:">', trigger('k:'))).toBe(
      'hello <img data-mx-emoticon="" alt=":a:">'
    );
  });

  it('keeps the space after an emote at the start of the message', () => {
    expect(stripProxyHtml('<img data-mx-emoticon alt=":a:"> hello -k', trigger(null, '-k'))).toBe(
      '<img data-mx-emoticon="" alt=":a:"> hello'
    );
  });

  it('trims whitespace between the trigger and an emote', () => {
    expect(stripProxyHtml('k: <img data-mx-emoticon alt=":a:"> ', trigger('k:'))).toBe(
      '<img data-mx-emoticon="" alt=":a:">'
    );
  });

  it('keeps the spaces between consecutive emotes', () => {
    expect(
      stripProxyHtml(
        'k: <img data-mx-emoticon alt=":a:"> <img data-mx-emoticon alt=":b:"> ',
        trigger('k:')
      )
    ).toBe('<img data-mx-emoticon="" alt=":a:"> <img data-mx-emoticon="" alt=":b:">');
  });

  it('keeps the space between formatted text and an emote', () => {
    expect(stripProxyHtml('k: <em>hi</em> <img data-mx-emoticon alt=":a:">', trigger('k:'))).toBe(
      '<em>hi</em> <img data-mx-emoticon="" alt=":a:">'
    );
  });

  it('trims a circumfix trigger around an emote and keeps the inner space', () => {
    expect(stripProxyHtml('[ hi <img data-mx-emoticon alt=":a:"> ]', trigger('[', ']'))).toBe(
      'hi <img data-mx-emoticon="" alt=":a:">'
    );
  });

  it('empties a message holding only whitespace between the triggers', () => {
    expect(stripProxyHtml('[   ]', trigger('[', ']'))).toBe('');
  });

  it('does not strip HTML that does not contain the trigger as text', () => {
    expect(stripProxyHtml('<em>test</em>', trigger('k:'))).toBeNull();
  });
});

describe('alternateAvatarId', () => {
  const kris = persona('Kris');
  const held = { persona_id: 'Kris', valid_until: null, alternate_avatar_id: 'smile' };

  it('uses the avatar a shorthand names', () => {
    expect(alternateAvatarId(kris, { ...trigger('k:'), alternate_avatar_id: 'wave' }, held)).toBe(
      'wave'
    );
  });

  it('does not keep the held avatar when a shorthand for the same persona names none', () => {
    expect(alternateAvatarId(kris, trigger('k:'), held)).toBe(null);
  });

  it('ignores an avatar held for another persona', () => {
    expect(alternateAvatarId(persona('Robin'), trigger('r:'), held)).toBeNull();
  });
});

describe('resolvePersona', () => {
  const kris = persona('Kris');
  const robin = persona('Robin');
  const personas = [kris, robin];

  it('prefers a proxied persona over every stored selection', () => {
    const resolved = resolvePersona({
      personas,
      proxied: robin,
      room: { persona_id: 'Kris', valid_until: null, alternate_avatar_id: null },
      now: 1000,
    });
    expect(resolved?.id).toBe('Robin');
  });

  it('prefers the room over the account', () => {
    const resolved = resolvePersona({
      personas,
      room: { persona_id: 'Robin', valid_until: null, alternate_avatar_id: null },
      account: { persona_id: 'Kris', valid_until: null, alternate_avatar_id: null },
      now: 1000,
    });
    expect(resolved?.id).toBe('Robin');
  });

  it('falls through an expired room selection to the account', () => {
    const resolved = resolvePersona({
      personas,
      room: { persona_id: 'Robin', valid_until: 500, alternate_avatar_id: null },
      account: { persona_id: 'Kris', valid_until: null, alternate_avatar_id: null },
      now: 1000,
    });
    expect(resolved?.id).toBe('Kris');
  });

  it('prefers the room, then the nearest space, then the account', () => {
    const space = { persona_id: 'Robin', valid_until: null, alternate_avatar_id: null };
    const account = { persona_id: 'Kris', valid_until: null, alternate_avatar_id: null };
    expect(resolvePersona({ personas, spaces: [space], account, now: 1000 })?.id).toBe('Robin');
    expect(
      resolvePersona({
        personas,
        room: { persona_id: 'Kris', valid_until: null, alternate_avatar_id: null },
        spaces: [space],
        now: 1000,
      })?.id
    ).toBe('Kris');
    expect(
      resolvePersona({
        personas,
        spaces: [
          undefined,
          { persona_id: 'Gone', valid_until: null, alternate_avatar_id: null },
          space,
        ],
        account,
        now: 1000,
      })?.id
    ).toBe('Robin');
    expect(
      resolvePersona({
        personas,
        spaces: [{ persona_id: 'Robin', valid_until: 500, alternate_avatar_id: null }],
        account,
        now: 1000,
      })?.id
    ).toBe('Kris');
  });

  it('stops at a room or space that is off, and takes a proxy with it', () => {
    const account = { persona_id: 'Kris', valid_until: null, alternate_avatar_id: null };
    const space = { persona_id: 'Robin', valid_until: null, alternate_avatar_id: null };
    expect(
      resolvePersona({ personas, spaces: [false, space], account, now: 1000 })
    ).toBeUndefined();
    expect(
      resolvePersona({
        personas,
        proxied: robin,
        spaces: [false],
        account,
        now: 1000,
      })
    ).toBeUndefined();
    expect(resolvePersona({ personas, room: false, spaces: [space], now: 1000 })).toBeUndefined();
  });

  it('sends as the account in a room or space set to it, while a trigger still proxies', () => {
    const account = { persona_id: 'Kris', valid_until: null, alternate_avatar_id: null };
    expect(resolvePersona({ personas, room: 'account', account, now: 1000 })).toBeUndefined();
    expect(resolvePersona({ personas, spaces: ['account'], account, now: 1000 })).toBeUndefined();
    expect(
      resolvePersona({ personas, proxied: robin, room: 'account', account, now: 1000 })?.id
    ).toBe('Robin');
  });

  it('lets a room selection override a space that is off', () => {
    const resolved = resolvePersona({
      personas,
      room: { persona_id: 'Robin', valid_until: null, alternate_avatar_id: null },
      spaces: [false],
      now: 1000,
    });
    expect(resolved?.id).toBe('Robin');
  });

  it('ignores a selection pointing at a deleted persona', () => {
    const resolved = resolvePersona({
      personas,
      room: { persona_id: 'Gone', valid_until: null, alternate_avatar_id: null },
      now: 1000,
    });
    expect(resolved).toBeUndefined();
  });

  it('resolves to nothing with no selection at all', () => {
    expect(resolvePersona({ personas, now: 1000 })).toBeUndefined();
  });
});

describe('projectPersona', () => {
  it('carries the fallback flag the core acts on', () => {
    expect(projectPersona(persona('Kris'), true).has_fallback).toBe(true);
    expect(projectPersona(persona('Kris'), false).has_fallback).toBe(false);
  });

  it('leaves the triggers and the import record behind', () => {
    const projected: Record<string, unknown> = projectPersona(
      persona('Kris', [trigger('k:')]),
      false
    );
    expect(projected.triggers).toBeUndefined();
    expect(projected.pluralkit).toBeUndefined();
  });
});
