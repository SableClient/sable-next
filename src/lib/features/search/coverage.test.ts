import i18next from 'i18next';
import { expect, test } from 'vitest';

import type { SearchCoverageView } from '#src/generated/SearchCoverageView';
import en from '../../../locales/en.json';

import { coverageMessage } from './coverage';

const instance = i18next.createInstance();
await instance.init({
  lng: 'en',
  resources: { en: { translation: en } },
  interpolation: { escapeValue: false },
});

const t = (key: string, options?: Record<string, unknown>): string => instance.t(key, options);

function coverage(overrides: Partial<SearchCoverageView>): SearchCoverageView {
  return {
    documents: 1000,
    rooms_pending: 0,
    rooms_failed: 0,
    state: 'complete',
    ...overrides,
  };
}

test('a coverage the core could not report warns rather than going quiet', () => {
  expect(coverageMessage(null, true, t)).toBe(
    'We could not check how much history has been indexed, so these results may be incomplete.'
  );
});

test('a coverage that has not arrived yet says nothing rather than crying wolf', () => {
  expect(coverageMessage(null, false, t)).toBe('');
});

test('an unfinished crawl says the history behind the query is still being read', () => {
  const message = coverageMessage(
    coverage({ documents: 1420, rooms_pending: 7, state: 'indexing' }),
    false,
    t
  );

  expect(message).toBe('1420 messages indexed so far. Still reading older history.');
});

test('a settled crawl claims the rooms were read to their start', () => {
  expect(coverageMessage(coverage({ documents: 20 }), false, t)).toBe(
    '20 messages indexed so far. Every room has been read back to its start.'
  );
});

test('rooms that errored are reported rather than counted as complete', () => {
  expect(
    coverageMessage(coverage({ documents: 20, rooms_failed: 3, state: 'partial' }), false, t)
  ).toBe(
    '20 messages indexed so far. 3 rooms could not be read and will be retried next time you sign in.'
  );
});

test('a single failed room is not pluralised by the message count', () => {
  expect(
    coverageMessage(coverage({ documents: 20, rooms_failed: 1, state: 'partial' }), false, t)
  ).toBe(
    '20 messages indexed so far. 1 room could not be read and will be retried next time you sign in.'
  );
});

test('a stopped crawl says the limit was reached rather than implying more is coming', () => {
  expect(coverageMessage(coverage({ documents: 50000, state: 'stopped' }), false, t)).toBe(
    "50000 messages indexed so far. Indexing stopped at this session's limit."
  );
});

test('one indexed message reads in the singular', () => {
  expect(coverageMessage(coverage({ documents: 1, state: 'indexing' }), false, t)).toBe(
    '1 message indexed so far. Still reading older history.'
  );
});
