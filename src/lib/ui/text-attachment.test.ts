import { expect, test } from 'vitest';

import { isTextAttachment, textAttachmentLanguage } from './text-attachment.js';

test.each([
  { mime: 'text/plain', body: 'notes.txt' },
  { mime: 'application/json', body: 'payload' },
  { mime: 'application/octet-stream', body: 'main.rs' },
  { mime: null, body: 'deploy.log' },
])('previews $body sent as $mime', ({ mime, body }) => {
  expect(isTextAttachment(mime, body)).toBe(true);
});

test.each([
  { mime: 'application/pdf', body: 'report.pdf' },
  { mime: 'application/zip', body: 'archive.zip' },
  { mime: 'image/png', body: 'shot.png' },
  { mime: null, body: 'blob' },
])('does not preview $body sent as $mime', ({ mime, body }) => {
  expect(isTextAttachment(mime, body)).toBe(false);
});

test('a pdf mimetype is never a text attachment, whatever the name says', () => {
  expect(isTextAttachment('application/pdf', 'notes.txt')).toBe(false);
});

test('the extension names the language, and the mimetype is the fallback', () => {
  expect(textAttachmentLanguage('application/octet-stream', 'main.rs')).toBe('rust');
  expect(textAttachmentLanguage('application/json', 'payload')).toBe('json');
  expect(textAttachmentLanguage('text/plain', 'notes.txt')).toBeNull();
});

test('a plain-text extension wins over a highlightable mimetype', () => {
  expect(textAttachmentLanguage('text/html', 'notes.txt')).toBeNull();
});
