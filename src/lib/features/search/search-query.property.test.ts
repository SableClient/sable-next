import fc from 'fast-check';
import { expect, test } from 'vitest';

import { parseSearchQuery, SEARCH_OPERATORS, type SearchToken } from './search-query';

const operator = fc.constantFrom(...SEARCH_OPERATORS);
const bareWord = fc
  .stringMatching(/^[a-zA-Z0-9]{1,12}$/)
  .filter((word) => !SEARCH_OPERATORS.some((name) => word.startsWith(name)));

const tokenSource = fc.record({
  operator,
  value: fc.stringMatching(/^[a-zA-Z0-9._-]{1,12}$/),
  negated: fc.boolean(),
});

function render(token: { operator: string; value: string; negated: boolean }): string {
  return `${token.negated ? '-' : ''}${token.operator}:${token.value}`;
}

test('every token the parser reports spans the text it was read from', () => {
  fc.assert(
    fc.property(fc.array(tokenSource, { maxLength: 6 }), bareWord, (tokens, trailing) => {
      const input = `${tokens.map(render).join(' ')} ${trailing}`;
      const parsed = parseSearchQuery(input);

      for (const token of parsed.tokens) {
        expect(input.slice(token.start, token.end)).toBe(render(token));
      }
    })
  );
});

test('tokens come back in the order they were written, and never overlap', () => {
  fc.assert(
    fc.property(fc.array(tokenSource, { minLength: 2, maxLength: 6 }), (tokens) => {
      const parsed = parseSearchQuery(tokens.map(render).join(' '));

      const starts = parsed.tokens.map((token) => token.start);
      expect([...starts].sort((left, right) => left - right)).toEqual(starts);
      parsed.tokens.forEach((token: SearchToken, index: number) => {
        if (index === 0) return;
        expect(token.start).toBeGreaterThanOrEqual(parsed.tokens[index - 1].end);
      });
    })
  );
});

test('free text never keeps a token that was recognised', () => {
  fc.assert(
    fc.property(fc.array(tokenSource, { maxLength: 6 }), bareWord, (tokens, trailing) => {
      const parsed = parseSearchQuery(`${tokens.map(render).join(' ')} ${trailing}`);

      for (const token of parsed.tokens) {
        expect(parsed.text).not.toContain(`${token.operator}:${token.value}`);
      }
      expect(parsed.text).toContain(trailing);
    })
  );
});

test('a quoted run is a phrase, and a minus-quoted run is an exclusion', () => {
  fc.assert(
    fc.property(bareWord, bareWord, (phrase, excluded) => {
      const parsed = parseSearchQuery(`"${phrase}" -"${excluded}"`);

      expect(parsed.phrases).toContain(phrase);
      expect(parsed.exclude).toContain(excluded);
    })
  );
});

test('parsing is idempotent over the text it leaves behind', () => {
  fc.assert(
    fc.property(fc.array(tokenSource, { maxLength: 6 }), bareWord, (tokens, trailing) => {
      const parsed = parseSearchQuery(`${tokens.map(render).join(' ')} ${trailing}`);
      const again = parseSearchQuery(parsed.text);

      expect(again.text).toBe(parsed.text);
      expect(again.tokens).toEqual([]);
    })
  );
});
