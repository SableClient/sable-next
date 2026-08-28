import { expect, test } from 'vitest';

import { parseSearchQuery, toSearchFilter } from './search-query';

const resolve = {
  roomId: (value: string) => (value === 'dev' ? '!dev:example.org' : undefined),
  userId: (value: string) => (value === 'erwan' ? '@erwan:example.org' : undefined),
  spaceRooms: (value: string) =>
    value === 'eng' ? ['!dev:example.org', '!ops:example.org'] : undefined,
};

function filterFor(query: string) {
  return toSearchFilter(parseSearchQuery(query), resolve).filter;
}

function resolveFor(query: string) {
  return toSearchFilter(parseSearchQuery(query), resolve);
}

test('plain words become the free text', () => {
  const parsed = parseSearchQuery('deploy pipeline broken');

  expect(parsed.text).toBe('deploy pipeline broken');
  expect(parsed.tokens).toEqual([]);
});

test('operators are lifted out of the free text', () => {
  const parsed = parseSearchQuery('deploy from:erwan in:dev has:image');

  expect(parsed.text).toBe('deploy');
  expect(
    parsed.tokens.map(({ operator, value, negated }) => ({ operator, value, negated }))
  ).toEqual([
    { operator: 'from', value: 'erwan', negated: false },
    { operator: 'in', value: 'dev', negated: false },
    { operator: 'has', value: 'image', negated: false },
  ]);
});

test('a quoted phrase leaves the free text and becomes a phrase', () => {
  const parsed = parseSearchQuery('"pipeline is broken" deploy');

  expect(parsed.phrases).toEqual(['pipeline is broken']);
  expect(parsed.text).toBe('deploy');
});

test('a leading dash excludes a term', () => {
  const parsed = parseSearchQuery('deploy -staging');

  expect(parsed.text).toBe('deploy');
  expect(parsed.exclude).toEqual(['staging']);
});

test('a negated sender is denied by identity, not as a body substring', () => {
  const filter = filterFor('deploy -from:erwan');

  expect(filter.senders).toEqual([]);
  expect(filter.not_senders).toEqual(['@erwan:example.org']);
  expect(filter.exclude).toEqual([]);
});

test('a space token expands to its resolved room ids', () => {
  const filter = filterFor('deploy space:eng');

  expect(filter.rooms).toEqual(['!dev:example.org', '!ops:example.org']);
});

test('a negated space token denies its resolved room ids', () => {
  const filter = filterFor('deploy -space:eng');

  expect(filter.rooms).toEqual([]);
  expect(filter.not_rooms).toEqual(['!dev:example.org', '!ops:example.org']);
});

test('an unresolvable space is reported rather than silently widening the search', () => {
  const { filter, unresolved } = resolveFor('deploy space:unknown');

  expect(filter.rooms).toEqual([]);
  expect(unresolved.map((token) => token.value)).toEqual(['unknown']);
});

test('a negated room is denied by identity', () => {
  const filter = filterFor('deploy -in:dev');

  expect(filter.rooms).toEqual([]);
  expect(filter.not_rooms).toEqual(['!dev:example.org']);
});

test('a negated attachment is denied by kind', () => {
  const filter = filterFor('deploy -has:image');

  expect(filter.has).toEqual([]);
  expect(filter.not_has).toEqual(['image']);
});

test('a negated operator that resolves to nothing is reported, not silently dropped', () => {
  const { filter, unresolved } = resolveFor('deploy -from:nobody');

  expect(filter.not_senders).toEqual([]);
  expect(unresolved.map((token) => token.value)).toEqual(['nobody']);
});

test('a negated date bound is reported as unsupported rather than guessed at', () => {
  const parsed = parseSearchQuery('deploy -before:2024-01-01');

  expect(parsed.unsupported).toEqual(['-before']);
  expect(parsed.tokens).toEqual([]);
});

test('a bare negated word is still a body exclusion', () => {
  const filter = filterFor('deploy -staging');

  expect(filter.exclude).toEqual(['staging']);
  expect(filter.not_senders).toEqual([]);
});

test('an unknown operator is treated as ordinary text', () => {
  const parsed = parseSearchQuery('deploy colour:red');

  expect(parsed.text).toBe('deploy colour:red');
  expect(parsed.tokens).toEqual([]);
});

test('pinned is reported as unsupported instead of silently ignored', () => {
  const parsed = parseSearchQuery('deploy pinned:true');

  expect(parsed.unsupported).toEqual(['pinned']);
  expect(parsed.text).toBe('deploy');
});

test('names resolve to matrix ids and unknown names are reported', () => {
  const { filter, unresolved } = resolveFor('from:erwan from:nobody in:dev in:missing');

  expect(filter.senders).toEqual(['@erwan:example.org']);
  expect(filter.rooms).toEqual(['!dev:example.org']);
  expect(unresolved.map((token) => token.value)).toEqual(['nobody', 'missing']);
});

test('an unresolvable target is reported so the query cannot silently widen', () => {
  expect(resolveFor('has:embed').unresolved.map((token) => token.value)).toEqual(['embed']);
  expect(resolveFor('after:not-a-date').unresolved.map((token) => token.value)).toEqual([
    'not-a-date',
  ]);
});

test('has aliases map onto the attachment kinds the core knows', () => {
  expect(filterFor('has:sound').has).toEqual(['audio']);
  expect(filterFor('has:Image').has).toEqual(['image']);
  expect(filterFor('has:embed').has).toEqual([]);
});

test('during bounds a single day at both ends', () => {
  const filter = filterFor('during:2026-03-15');

  expect(filter.after_ts).toBe(Date.parse('2026-03-15T00:00:00'));
  expect(filter.before_ts).toBe(Date.parse('2026-03-15T00:00:00') + 86_399_999);
});

test('before and after set one bound each', () => {
  const filter = filterFor('after:2026-01-01 before:2026-02-01');

  expect(filter.after_ts).toBe(Date.parse('2026-01-01T00:00:00'));
  expect(filter.before_ts).toBe(Date.parse('2026-02-01T00:00:00'));
});

test('an unparseable date is ignored rather than sent as NaN', () => {
  const filter = filterFor('after:not-a-date');

  expect(filter.after_ts).toBeNull();
});

test('an operator with no value is not a filter', () => {
  const parsed = parseSearchQuery('from: deploy');

  expect(parsed.tokens).toEqual([]);
  expect(parsed.text).toBe('deploy');
});

test('a colon inside a matrix id survives', () => {
  const withId = {
    roomId: () => undefined,
    userId: (value: string) => (value === '@erwan:example.org' ? value : undefined),
    spaceRooms: () => undefined,
  };
  const { filter } = toSearchFilter(parseSearchQuery('from:@erwan:example.org'), withId);

  expect(filter.senders).toEqual(['@erwan:example.org']);
});

test('an operator value may be quoted so it can contain spaces', () => {
  const parsed = parseSearchQuery('deploy in:"Design crew" from:"Ada Lovelace"');

  expect(parsed.text).toBe('deploy');
  expect(parsed.tokens.map(({ operator, value }) => ({ operator, value }))).toEqual([
    { operator: 'in', value: 'Design crew' },
    { operator: 'from', value: 'Ada Lovelace' },
  ]);
  expect(parsed.phrases).toEqual([]);
});

test('a negated quoted operator still excludes its value', () => {
  const parsed = parseSearchQuery('-in:"Design crew"');

  expect(
    parsed.tokens.map(({ operator, value, negated }) => ({ operator, value, negated }))
  ).toEqual([{ operator: 'in', value: 'Design crew', negated: true }]);
});

test('a bare quoted string stays a phrase rather than an operator value', () => {
  const parsed = parseSearchQuery('"Design crew"');

  expect(parsed.phrases).toEqual(['Design crew']);
  expect(parsed.tokens).toEqual([]);
});

test('a token records where it sits so its span can be lifted out exactly', () => {
  const query = 'deploy in:dev broke';
  const [token] = parseSearchQuery(query).tokens;

  expect(query.slice(token.start, token.end)).toBe('in:dev');
});

test('a quoted token span covers the quotes', () => {
  const query = 'in:"Design crew" deploy';
  const [token] = parseSearchQuery(query).tokens;

  expect(query.slice(token.start, token.end)).toBe('in:"Design crew"');
});
