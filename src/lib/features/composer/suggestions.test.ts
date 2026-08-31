import type { MemberView } from '#src/generated/MemberView';
import type { PackImageView } from '#src/generated/PackImageView';
import type { RoomSummary } from '#src/generated/RoomSummary';
import { expect, test } from 'vitest';

import type { AutocompleteQuery } from './autocomplete';
import { suggestionsFor } from './suggestions';

function member(userId: string, displayName: string | null): MemberView {
  return {
    user_id: userId,
    display_name: displayName,
    avatar_url: null,
    power_level: 0,
    membership: 'join' as const,
    member_ts: null,
    kicked: false,
  };
}

function emote(shortcode: string): PackImageView {
  return {
    shortcode,
    url: `mxc://example.org/${shortcode}`,
    body: null,
    usage: ['emoticon'],
    info: null,
  };
}

function mentionQuery(text: string): AutocompleteQuery {
  return { sigil: '@', query: text, start: 0, end: text.length + 1 };
}

function emoteQuery(text: string): AutocompleteQuery {
  return { sigil: ':', query: text, start: 0, end: text.length + 1 };
}

function roomQuery(text: string): AutocompleteQuery {
  return { sigil: '#', query: text, start: 0, end: text.length + 1 };
}

function commandQuery(text: string): AutocompleteQuery {
  return { sigil: '/', query: text, start: 0, end: text.length + 1 };
}

function room(room_id: string, name: string, canonical_alias: string | null = null): RoomSummary {
  return { room_id, name, canonical_alias, avatar_url: null } as RoomSummary;
}

test('a member matches on display name or localpart, never on the homeserver', () => {
  const members = [
    member('@one:example.org', 'Member One'),
    member('@zed:member.example', 'Zed'),
    member('@member:other.example', null),
  ];

  expect(suggestionsFor(mentionQuery('member'), members, [], []).map((item) => item.id)).toEqual([
    '@member:other.example',
    '@one:example.org',
  ]);
});

test('prefix matches come before contained ones, then alphabetical', () => {
  const members = [
    member('@c:example.org', 'Zoe Anders'),
    member('@a:example.org', 'Anders Bo'),
    member('@b:example.org', 'Ana Diaz'),
  ];

  expect(suggestionsFor(mentionQuery('an'), members, [], []).map((item) => item.label)).toEqual([
    '@Ana Diaz',
    '@Anders Bo',
    '@Zoe Anders',
  ]);
});

test('a member without a display name falls back to the user id', () => {
  const suggestions = suggestionsFor(
    mentionQuery('one'),
    [member('@one:example.org', null)],
    [],
    []
  );

  expect(suggestions.map((item) => item.insert)).toEqual(['@one:example.org']);
});

test('at most eight suggestions reach the panel', () => {
  const members = Array.from({ length: 20 }, (_, index) =>
    member(`@member${String(index)}:example.org`, `Member ${String(index)}`)
  );

  expect(suggestionsFor(mentionQuery('member'), members, [], [])).toHaveLength(8);
});

test('pack emotes come first, then native emoji fill the panel', () => {
  const suggestions = suggestionsFor(emoteQuery('wa'), [], [emote('unwave'), emote('wave')], []);

  expect(suggestions.slice(0, 2).map((item) => item.insert)).toEqual([':wave:', ':unwave:']);
  expect(suggestions[0]?.imageUrl).toBe('mxc://example.org/wave');
  expect(suggestions).toHaveLength(8);
  expect(suggestions.slice(2).every((item) => item.id.startsWith('emoji:'))).toBe(true);
});

test('a shortcode with no pack match still finds a native emoji', () => {
  const suggestions = suggestionsFor(emoteQuery('joy'), [], [], []);

  expect(suggestions[0]?.insert).toBe('😂');
  expect(suggestions[0]?.detail).toBe(':joy:');
});

test('no query means no suggestions', () => {
  expect(suggestionsFor(null, [member('@one:example.org', 'One')], [emote('wave')], [])).toEqual(
    []
  );
});

test('slash commands are filtered by their name', () => {
  expect(suggestionsFor(commandQuery('me'), [], [], []).map((item) => item.id)).toEqual([
    'me',
    'rainbowme',
    'roomname',
  ]);
});

test('gif is available as a slash command', () => {
  expect(suggestionsFor(commandQuery('gif'), [], [], []).map((item) => item.id)).toEqual(['gif']);
});

test('rooms match their name or alias and insert a # label', () => {
  const suggestions = suggestionsFor(
    roomQuery('gen'),
    [],
    [],
    [
      room('!one:example.org', 'General', '#general:example.org'),
      room('!two:example.org', 'Off topic'),
    ]
  );

  expect(suggestions).toEqual([
    expect.objectContaining({
      id: '#general:example.org',
      insert: '#General',
      label: '#General',
      detail: '#general:example.org',
    }),
  ]);
});

test('a room name that already starts with # keeps a single #', () => {
  const [suggestion] = suggestionsFor(
    roomQuery('gen'),
    [],
    [],
    [room('!one:example.org', '#General')]
  );

  expect(suggestion.label).toBe('#General');
});

test('@room is offered while the needle still prefixes it', () => {
  const members = [member('@rob:example.org', 'Rob')];

  expect(suggestionsFor(mentionQuery('ro'), members, [], []).map((item) => item.id)).toEqual([
    '@room',
    '@rob:example.org',
  ]);
  expect(suggestionsFor(mentionQuery('rob'), members, [], []).map((item) => item.id)).toEqual([
    '@rob:example.org',
  ]);
});

test('a translator passed in is what renders the command descriptions', () => {
  const [suggestion] = suggestionsFor(commandQuery('me'), [], [], [], (key) => `translated:${key}`);

  expect(suggestion.detail).toBe('translated:composer.slash.me.description');
});
