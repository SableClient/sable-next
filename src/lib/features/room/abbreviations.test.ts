// @vitest-environment happy-dom

import { expect, test } from 'vitest';

import type { RoomSummary } from '#src/generated/protocol';

import {
  abbreviationPattern,
  ancestorSpaceIds,
  buildAbbreviationMap,
  markAbbreviations,
} from './abbreviations';

function mark(html: string, entries: [string, string][]): string {
  const map = buildAbbreviationMap(entries.map(([term, definition]) => ({ term, definition })));
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
