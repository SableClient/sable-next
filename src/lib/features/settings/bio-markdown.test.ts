// @vitest-environment happy-dom

import { expect, test } from 'vitest';

import { bioMarkdown, bioTexts } from './bio-markdown';

test('a formatted bio is edited as markdown', () => {
  expect(bioMarkdown('<p>I like <strong>cats</strong> and <em>tea</em></p>')).toBe(
    'I like **cats** and *tea*'
  );
});

test('markdown is saved as html with the markdown as its plain body', () => {
  expect(bioTexts('I like **cats**')).toEqual([
    { body: 'I like <strong>cats</strong>', mimetype: 'text/html' },
    { body: 'I like **cats**' },
  ]);
});

test('a plain bio is saved without an html copy', () => {
  expect(bioTexts('just words')).toEqual([{ body: 'just words' }]);
});

test('a bio survives the round trip', () => {
  const [html] = bioTexts('I like **cats** and *tea*');
  expect(bioMarkdown(html.body)).toBe('I like **cats** and *tea*');
});
