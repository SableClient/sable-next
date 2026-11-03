import { expect, test } from 'vitest';

import { expectNoA11yViolations, a11yViolations } from './a11y.js';
import { expectSingleTabStop, tabStops } from './keyboard.js';

function mount(html: string): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.append(root);
  return root;
}

function widget(root: HTMLElement): Element {
  const element = root.firstElementChild;
  if (!element) throw new Error('empty fixture');
  return element;
}

test('axe passes a labelled control and flags an unlabelled one', async () => {
  const good = mount('<button type="button">Send</button>');
  await expectNoA11yViolations(good);
  const bad = mount('<button type="button"></button>');
  expect(await a11yViolations(bad)).toEqual([expect.stringContaining('button-name')]);
  await expectNoA11yViolations(bad, {
    disableRules: { 'button-name': 'fixture is intentionally bare' },
  });
});

test('tabStops skips negative tabindex, disabled and hidden elements', () => {
  const root = mount(`
    <button id="a">a</button>
    <button tabindex="-1">b</button>
    <button disabled>c</button>
    <button style="display:none">d</button>
    <a href="#x" id="e">e</a>`);
  expect(tabStops(root).map((stop) => stop.id)).toEqual(['a', 'e']);
});

test('expectSingleTabStop accepts a roving toolbar and rejects a plain one', () => {
  const roving = mount(
    '<div role="toolbar"><button>a</button><button tabindex="-1">b</button></div>'
  );
  expectSingleTabStop(widget(roving));

  const plain = mount('<div role="toolbar"><button>a</button><button>b</button></div>');
  expect(() => {
    expectSingleTabStop(widget(plain));
  }).toThrow('one tab stop');
});
