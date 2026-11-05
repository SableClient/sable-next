// @vitest-environment happy-dom

import { expect, test } from 'vitest';

import { bioContent, bioHtml, bioTexts } from './bio-content';

test('a formatted bio keeps its html and a markdown fallback', () => {
  expect(bioTexts(bioContent('<p>I like <strong>cats</strong> and <em>tea</em></p>'))).toEqual([
    { body: 'I like <strong>cats</strong> and <em>tea</em>', mimetype: 'text/html' },
    { body: 'I like **cats** and *tea*' },
  ]);
});

test('a plain bio is saved without an html copy', () => {
  expect(bioTexts(bioContent('just words'))).toEqual([{ body: 'just words' }]);
});

test('custom emoji and inline images survive loading, previewing, and saving', () => {
  const html =
    '<p>Hello <img data-mx-emoticon src="mxc://example.org/wave" alt=":wave:" title=":wave:"> <img src="mxc://example.org/cat" alt="Cat"></p>';
  const bio = bioContent(html);
  for (const rendered of [bioHtml(bio), bioTexts(bio)[0].body]) {
    const container = document.createElement('div');
    container.innerHTML = rendered ?? '';
    const images = container.querySelectorAll('img');
    expect(images).toHaveLength(2);
    expect(images[0].hasAttribute('data-mx-emoticon')).toBe(true);
    expect(images[0].getAttribute('src')).toBe('mxc://example.org/wave');
    expect(images[1].getAttribute('src')).toBe('mxc://example.org/cat');
    expect(bioContent(rendered ?? '')).toEqual(bio);
  }
  expect(bio.body).toContain(':wave:');
});

test('plain preview text is escaped and an empty bio clears the preview', () => {
  expect(bioHtml({ body: '<tag> & text', formatted: null })).toBe('<p>&lt;tag&gt; &amp; text</p>');
  expect(bioHtml(bioContent(''))).toBeNull();
});

test('line breaks survive the preview', () => {
  expect(bioHtml(bioContent('<p>first<br>second</p>'))).toBe('<p>first<br>second</p>');
});
