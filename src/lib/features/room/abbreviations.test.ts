// @vitest-environment happy-dom

import { expect, test } from 'vitest';

import { abbreviationPattern, buildAbbreviationMap, markAbbreviations } from './abbreviations';
import type { AbbreviationEntry } from './settings/abbreviations';

function mark(html: string, entries: [string, string][]): string {
  return markEntries(
    html,
    entries.map(([term, definition]) => ({ term, definition, cased: false }))
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
      { term: 'do', definition: 'to do', cased: false },
    ])
  ).toBe(
    '<p><abbr data-abbr-definition="Digital Ocean" tabindex="0">DO</abbr> <abbr data-abbr-definition="to do" tabindex="0">do</abbr></p>'
  );
});

test('a cased term and an uncased term with the same lowercased letters both match', () => {
  expect(
    markEntries('<p>DO do</p>', [
      { term: 'DO', definition: 'to do', cased: false },
      { term: 'do', definition: 'to do, cased', cased: true },
    ])
  ).toBe(
    '<p><abbr data-abbr-definition="to do" tabindex="0">DO</abbr> <abbr data-abbr-definition="to do, cased" tabindex="0">do</abbr></p>'
  );
});

test('an uncased term still matches any casing', () => {
  expect(markEntries('<p>DO</p>', [{ term: 'do', definition: 'to do', cased: false }])).toBe(
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

test('leaves a term followed by an accented letter alone', () => {
  expect(mark('<p>présenter PR</p>', [['pr', 'Pull Request']])).toBe(
    '<p>présenter <abbr data-abbr-definition="Pull Request" tabindex="0">PR</abbr></p>'
  );
});
