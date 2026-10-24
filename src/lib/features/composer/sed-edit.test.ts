// @vitest-environment happy-dom

import { expect, test } from 'vitest';

import { applySed, applySedToHtml, parseSed } from './sed-edit';

const sed = (text: string) => {
  const parsed = parseSed(text);
  if (!parsed) throw new Error(`${text} is not a sed edit`);
  return parsed;
};

test('replaces the first match only', () => {
  expect(applySed('one fish two fish', sed('s/fish/cat'))).toBe('one cat two fish');
  expect(applySed('one fish two fish', sed('s/fish/cat/'))).toBe('one cat two fish');
});

test('matches plain text, case and all', () => {
  expect(applySed('One FISH', sed('s/fish/cat'))).toBeNull();
  expect(applySed('1+1=2', sed('s/1+1/2*1'))).toBe('2*1=2');
});

test('the replacement is literal, so dollar patterns are kept', () => {
  expect(applySed('cost', sed('s/cost/$& $1'))).toBe('$& $1');
});

test('an empty replacement deletes the match', () => {
  expect(applySed('a typo here', sed('s/typo //'))).toBe('a here');
});

test('an escaped slash belongs to the find text or the replacement', () => {
  expect(applySed('a/b', sed('s/a\\/b/c\\/d'))).toBe('c/d');
});

test('reports a message that does not contain the find text', () => {
  expect(applySed('one fish', sed('s/dog/cat'))).toBeNull();
});

test('stays out of the way of anything that is not a sed edit', () => {
  for (const text of ['hello', 's/only', 's//x', 's/a/b/g', 'see s/a/b', '/s/a/b', 's/a/b\nc']) {
    expect(parseSed(text), text).toBeNull();
  }
});

test('keeps the formatting around and on the replaced text', () => {
  const edited = applySedToHtml('<p>one <strong>fish</strong> <em>two</em></p>', sed('s/fish/cat'));
  expect(edited?.body).toBe('one **cat** *two*');
  expect(edited?.formatted).toContain('<strong>cat</strong>');
  expect(edited?.formatted).toContain('<em>two</em>');
});

test('matches text that crosses formatting', () => {
  const edited = applySedToHtml('<p>a f<em>is</em>h b</p>', sed('s/fish/cat'));
  expect(edited?.body).toBe('a cat b');
});

test('keeps the mentions of the edited message', () => {
  const edited = applySedToHtml(
    '<p><a href="https://matrix.to/#/@ana:example.org">Ana</a> one fish</p>',
    sed('s/fish/cat')
  );
  expect(edited?.formatted).toContain('https://matrix.to/#/@ana:example.org');
  expect([...(edited?.mentions.user_ids ?? [])]).toEqual(['@ana:example.org']);
});

test('an empty replacement deletes the formatted match', () => {
  expect(applySedToHtml('<p>a <strong>typo</strong> here</p>', sed('s/typo //'))?.body).toBe(
    'a here'
  );
});

test('reports formatted text that does not contain the find text', () => {
  expect(applySedToHtml('<p>one <strong>fish</strong></p>', sed('s/dog/cat'))).toBeNull();
});
