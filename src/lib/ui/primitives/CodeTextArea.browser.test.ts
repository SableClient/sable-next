import { expect, test } from 'vitest';
import { render } from 'vitest-browser-svelte';

import '../../../styles.css';

import CodeTextArea from './CodeTextArea.svelte';

const images = Object.fromEntries(
  Array.from({ length: 40 }, (_, index) => [
    `emote_${'x'.repeat(index % 17)}`,
    { url: `mxc://example.org/${'a'.repeat(10 + ((index * 7) % 31))}`, body: 'b'.repeat(index) },
  ])
);
const content = JSON.stringify({ images }, null, 2);

test('the highlighted layer wraps like the textarea so the last lines stay reachable', async () => {
  const screen = await render(CodeTextArea, { language: 'json', value: content });
  screen.container.style.width = '24rem';
  const area = screen.container.querySelector('textarea');
  const layer = screen.container.querySelector('pre');
  await expect.poll(() => layer?.querySelector('a-s')).toBeTruthy();
  await document.fonts.ready;

  expect(layer?.scrollHeight).toBe(area?.scrollHeight);
});
