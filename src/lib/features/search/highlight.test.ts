import { expect, test } from 'vitest';

import { highlightSegments, snippetAround } from './highlight';

test('no terms leaves the body in one unmatched segment', () => {
  expect(highlightSegments('the deploy broke', [])).toEqual([
    { text: 'the deploy broke', match: false },
  ]);
});

test('a term is split out and marked, case-insensitively', () => {
  expect(highlightSegments('The Deploy broke', ['deploy'])).toEqual([
    { text: 'The ', match: false },
    { text: 'Deploy', match: true },
    { text: ' broke', match: false },
  ]);
});

test('several terms are all marked', () => {
  const segments = highlightSegments('deploy the pipeline', ['deploy', 'pipeline']);

  expect(segments.filter((segment) => segment.match).map((segment) => segment.text)).toEqual([
    'deploy',
    'pipeline',
  ]);
});

test('a term full of regex metacharacters neither throws nor matches everything', () => {
  expect(highlightSegments('a (b) c', ['.*+?'])).toEqual([{ text: 'a (b) c', match: false }]);
});

test('a term that does not occur leaves the body whole', () => {
  expect(highlightSegments('nothing here', ['absent'])).toEqual([
    { text: 'nothing here', match: false },
  ]);
});

test('a stemmed hit is still marked', () => {
  const marked = (body: string, terms: string[]) =>
    highlightSegments(body, terms)
      .filter((segment) => segment.match)
      .map((segment) => segment.text);

  expect(marked('the deployed build', ['deploy'])).toEqual(['deployed']);
  expect(marked('the deploy build', ['deployed'])).toEqual(['deploy']);
  expect(marked('deployment pipeline', ['deploy'])).toEqual(['deployment']);
});

test('a two-letter term does not match every word sharing its prefix', () => {
  expect(
    highlightSegments('at the attic', ['at'])
      .filter((segment) => segment.match)
      .map((segment) => segment.text)
  ).toEqual(['at']);
});

test('only whole words are marked', () => {
  expect(
    highlightSegments('redeploy the deploy', ['deploy'])
      .filter((segment) => segment.match)
      .map((segment) => segment.text)
  ).toEqual(['deploy']);
});

test('a long body is windowed around the first match', () => {
  const body = `${'filler '.repeat(40)}needle${' tail'.repeat(40)}`;
  const snippet = snippetAround(body, ['needle']);

  expect(snippet.clippedStart).toBe(true);
  expect(snippet.clippedEnd).toBe(true);
  expect(snippet.segments.some((segment) => segment.match)).toBe(true);
  expect(snippet.segments.map((segment) => segment.text).join('').length).toBeLessThan(body.length);
});

test('a short body is not clipped', () => {
  const snippet = snippetAround('deploy broke', ['deploy']);

  expect(snippet.clippedStart).toBe(false);
  expect(snippet.clippedEnd).toBe(false);
});

test('a quoted phrase is marked as one span, not word by word', () => {
  expect(highlightSegments('the General message 1 here', ['General message 1'])).toEqual([
    { text: 'the ', match: false },
    { text: 'General message 1', match: true },
    { text: ' here', match: false },
  ]);
});

test('a phrase tolerates differing runs of whitespace', () => {
  expect(
    highlightSegments('a  deploy   broke b', ['deploy broke'])
      .filter((segment) => segment.match)
      .map((segment) => segment.text)
  ).toEqual(['deploy   broke']);
});

test('a phrase and a loose term both mark without overlapping', () => {
  expect(
    highlightSegments('deploy broke the pipeline', ['deploy broke', 'pipeline'])
      .filter((segment) => segment.match)
      .map((segment) => segment.text)
  ).toEqual(['deploy broke', 'pipeline']);
});

test('a term does not mark a much longer word that merely starts with it', () => {
  const marked = (body: string, terms: string[]) =>
    highlightSegments(body, terms)
      .filter((segment) => segment.match)
      .map((segment) => segment.text);

  expect(marked('a java runtime', ['javascript'])).toEqual([]);
  expect(marked('the category list', ['cat'])).toEqual([]);
  expect(marked('a theory of there', ['the'])).toEqual([]);
  expect(marked('deployment pipeline', ['deploy'])).toEqual(['deployment']);
});

test('a body that fits the window is never clipped, wherever the match sits', () => {
  const body = `${'x'.repeat(96)} needle`;
  const snippet = snippetAround(body, ['needle']);

  expect(body.length).toBeLessThanOrEqual(180);
  expect(snippet.clippedStart).toBe(false);
  expect(snippet.clippedEnd).toBe(false);
  expect(snippet.segments.map((segment) => segment.text).join('')).toBe(body);
});
