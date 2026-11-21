// @vitest-environment happy-dom

import { expect, test } from 'vitest';

import { splitCodeLines } from './code-lines.js';

test('preserves nested tokens and blank lines when splitting highlighted code', () => {
  const code = document.createElement('code');
  code.innerHTML = '<a-s>"a\n\n<a-se>\\n</a-se>\nb"</a-s>\n';

  splitCodeLines(code);

  expect(code.textContent).toBe('"a\n\n\\n\nb"\n');
  expect([...code.children].map((line) => line.innerHTML)).toEqual([
    '<a-s>"a</a-s>',
    '',
    '<a-s><a-se>\\n</a-se></a-s>',
    '<a-s>b"</a-s>',
    '',
  ]);
});
