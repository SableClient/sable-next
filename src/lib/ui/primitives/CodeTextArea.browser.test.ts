import { expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';

import '../../../styles.css';

import CodeTextArea from './CodeTextArea.svelte';

const content = JSON.stringify(
  Object.fromEntries(
    Array.from({ length: 40 }, (_, index) => [`key_${index}`, 'a'.repeat(index * 2)])
  ),
  null,
  2
);

test('highlight layer wraps like the textarea', async () => {
  const screen = await render(CodeTextArea, { language: 'json', value: content });
  screen.container.style.width = '24rem';
  const area = screen.container.querySelector('textarea');
  const layer = screen.container.querySelector('pre');
  await expect.poll(() => layer?.querySelector('a-s')).toBeTruthy();
  await document.fonts.ready;

  expect(layer?.scrollHeight).toBe(area?.scrollHeight);
});
