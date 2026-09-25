// @vitest-environment happy-dom

import { expect, test } from 'vitest';

import type { RoomSummary } from '#src/generated/protocol';

import {
  abbreviationPattern,
  ancestorSpaceIds,
  buildAbbreviationMap,
  descendantRoomIds,
  markAbbreviations,
} from './abbreviations';
import type { AbbreviationEntry } from './settings/abbreviations';

function mark(html: string, entries: [string, string][]): string {
  return markEntries(
    html,
    entries.map(([term, definition]) => ({ term, definition }))
  );
}

function markEntries(html: string, entries: AbbreviationEntry[]): string {
  const map = buildAbbreviationMap(entries);
  const pattern = abbreviationPattern(map);
  const root = document.createElement('div');
  root.innerHTML = html;
  if (pattern) markAbbreviations(root, map, pattern);
  return root.innerHTML;
}

function space(roomId: string, children: string[]): RoomSummary {
  return {
    room_id: roomId,
    is_space: true,
    state: 'joined',
    space_children: children.map((child) => ({ room_id: child })),
  } as unknown as RoomSummary;
}

test('marks a term whole-word and case-insensitively, keeping its casing', () => {
  expect(mark('<p>the foss build and FOSS again</p>', [['foss', 'Free software']])).toBe(
    '<p>the <abbr data-abbr-definition="Free software" tabindex="0">foss</abbr> build and <abbr data-abbr-definition="Free software" tabindex="0">FOSS</abbr> again</p>'
  );
});

test('leaves a term embedded in a longer word alone', () => {
  expect(mark('<p>fossil</p>', [['foss', 'Free software']])).toBe('<p>fossil</p>');
});

test('a cased term only matches its exact casing', () => {
  expect(
    markEntries('<p>DO do Do</p>', [{ term: 'DO', definition: 'Digital Ocean', cased: true }])
  ).toBe('<p><abbr data-abbr-definition="Digital Ocean" tabindex="0">DO</abbr> do Do</p>');
});

test('a cased term and a case-insensitive term can share the same letters', () => {
  expect(
    markEntries('<p>DO do</p>', [
      { term: 'DO', definition: 'Digital Ocean', cased: true },
      { term: 'do', definition: 'to do' },
    ])
  ).toBe(
    '<p><abbr data-abbr-definition="Digital Ocean" tabindex="0">DO</abbr> <abbr data-abbr-definition="to do" tabindex="0">do</abbr></p>'
  );
});

test('a cased term and an uncased term with the same lowercased letters both match', () => {
  expect(
    markEntries('<p>DO do</p>', [
      { term: 'DO', definition: 'to do' },
      { term: 'do', definition: 'to do, cased', cased: true },
    ])
  ).toBe(
    '<p><abbr data-abbr-definition="to do" tabindex="0">DO</abbr> <abbr data-abbr-definition="to do, cased" tabindex="0">do</abbr></p>'
  );
});

test('an uncased term still matches any casing', () => {
  expect(markEntries('<p>DO</p>', [{ term: 'do', definition: 'to do' }])).toBe(
    '<p><abbr data-abbr-definition="to do" tabindex="0">DO</abbr></p>'
  );
});

test('prefers the longest term', () => {
  expect(
    mark('<p>PR review</p>', [
      ['pr', 'Pull request'],
      ['pr review', 'Code review'],
    ])
  ).toBe('<p><abbr data-abbr-definition="Code review" tabindex="0">PR review</abbr></p>');
});

test('never marks inside a link, code or an existing abbreviation', () => {
  const html = '<a href="https://pr.example.org">PR</a><code>PR</code><abbr title="x">PR</abbr>';
  expect(mark(html, [['pr', 'Pull request']])).toBe(html);
});

test('walks every joined space above the room, farthest first', () => {
  const rooms = [
    space('!root:example.org', ['!mid:example.org']),
    space('!mid:example.org', ['!room:example.org']),
  ];
  expect(ancestorSpaceIds(rooms, '!room:example.org')).toEqual([
    '!root:example.org',
    '!mid:example.org',
  ]);
});

test('stops on a cycle', () => {
  const rooms = [
    space('!a:example.org', ['!b:example.org']),
    space('!b:example.org', ['!a:example.org']),
  ];
  expect(ancestorSpaceIds(rooms, '!a:example.org')).toEqual(['!b:example.org']);
});

test('walks every joined room and subspace below a space, nearest first', () => {
  const room = (roomId: string) =>
    ({ room_id: roomId, state: 'joined', space_children: [] }) as unknown as RoomSummary;
  const rooms = [
    space('!root:example.org', ['!mid:example.org', '!a:example.org', '!gone:example.org']),
    space('!mid:example.org', ['!b:example.org', '!root:example.org']),
    room('!a:example.org'),
    room('!b:example.org'),
  ];
  expect(descendantRoomIds(rooms, '!root:example.org')).toEqual([
    '!mid:example.org',
    '!a:example.org',
    '!b:example.org',
  ]);
});
