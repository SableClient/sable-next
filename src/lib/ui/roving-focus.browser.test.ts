import { expect, test, vi } from 'vitest';
import { userEvent } from 'vitest/browser';

import { expectSingleTabStop, tabStops } from '#lib/test-support/keyboard.js';

import { rovingFocus } from './roving-focus.js';

function mount(html: string, options?: Parameters<typeof rovingFocus>[0]): HTMLElement {
  const root = document.createElement('div');
  root.innerHTML = html;
  document.body.append(root);
  rovingFocus(options)(root);
  return root;
}

test('the container becomes one tab stop and arrows move between controls', async () => {
  const root = mount('<button id="a">a</button><button id="b">b</button><button id="c">c</button>');
  expectSingleTabStop(root);

  await userEvent.tab();
  expect(document.activeElement?.id).toBe('a');
  await userEvent.keyboard('{ArrowRight}');
  expect(document.activeElement?.id).toBe('b');
  await userEvent.keyboard('{End}');
  expect(document.activeElement?.id).toBe('c');
  await userEvent.keyboard('{ArrowRight}');
  expect(document.activeElement?.id).toBe('c');
  await userEvent.keyboard('{Home}');
  expect(document.activeElement?.id).toBe('a');
});

test('Tab returns to the last focused control', () => {
  const root = mount('<button id="a">a</button><button id="b">b</button>');
  root.querySelector<HTMLElement>('#b')?.focus();
  expect(tabStops(root).map((stop) => stop.id)).toEqual(['b']);
});

test('disabled controls are skipped and added controls join in', async () => {
  const root = mount('<button id="a">a</button><button id="b" disabled>b</button>');
  const added = document.createElement('button');
  added.id = 'c';
  root.append(added);
  await Promise.resolve();

  root.querySelector<HTMLElement>('#a')?.focus();
  await userEvent.keyboard('{ArrowRight}');
  expect(document.activeElement?.id).toBe('c');
});

test('vertical containers answer to up and down', async () => {
  const root = mount('<button id="a">a</button><button id="b">b</button>', {
    orientation: 'vertical',
  });
  root.querySelector<HTMLElement>('#a')?.focus();
  await userEvent.keyboard('{ArrowRight}');
  expect(document.activeElement?.id).toBe('a');
  await userEvent.keyboard('{ArrowDown}');
  expect(document.activeElement?.id).toBe('b');
});

test('looping is opt-in', async () => {
  const root = mount('<button id="a">a</button><button id="b">b</button>', { loop: true });
  root.querySelector<HTMLElement>('#b')?.focus();
  await userEvent.keyboard('{ArrowRight}');
  expect(document.activeElement?.id).toBe('a');
});

test('arrow keys keep editing text inside an input', async () => {
  const root = mount(
    '<button id="a">a</button><input id="t" value="abc"><button id="b">b</button>'
  );
  const input = root.querySelector<HTMLInputElement>('#t');
  input?.focus();
  await userEvent.keyboard('{ArrowLeft}');
  expect(document.activeElement?.id).toBe('t');
});

test('focus moves to a neighbour when the focused control is removed', async () => {
  const root = mount('<button id="a">a</button><button id="b">b</button><button id="c">c</button>');
  root.querySelector<HTMLElement>('#b')?.focus();
  root.querySelector('#b')?.remove();
  await vi.waitFor(() => {
    expect(document.activeElement?.id).toBe('c');
  });
  expect(tabStops(root).map((stop) => stop.id)).toEqual(['c']);
});

test('Tab first lands on the current item', async () => {
  const root = mount(
    '<a href="#a" id="a">a</a><a href="#b" id="b" aria-current="page">b</a><a href="#c" id="c">c</a>'
  );
  await userEvent.tab();
  expect(document.activeElement?.id).toBe('b');
  expect(tabStops(root).map((stop) => stop.id)).toEqual(['b']);
});

const TREE = `
  <a id="a" role="treeitem" aria-level="1" href="#a">a</a>
  <button id="f" role="treeitem" aria-level="1" aria-expanded="true">f</button>
  <div role="group">
    <a id="c1" role="treeitem" aria-level="2" href="#c1">c1</a>
    <a id="c2" role="treeitem" aria-level="2" href="#c2">c2</a>
  </div>
  <button id="g" role="treeitem" aria-level="1" aria-expanded="false">g</button>`;

function mountTree(): HTMLElement {
  const root = mount(TREE, { tree: true });
  for (const toggle of root.querySelectorAll<HTMLElement>('[aria-expanded]')) {
    toggle.addEventListener('click', () => {
      toggle.setAttribute('aria-expanded', String(toggle.ariaExpanded !== 'true'));
    });
  }
  return root;
}

test('a tree is one tab stop and up and down walk the visible treeitems', async () => {
  const root = mountTree();
  expectSingleTabStop(root);
  root.querySelector<HTMLElement>('#a')?.focus();
  await userEvent.keyboard('{ArrowDown}{ArrowDown}');
  expect(document.activeElement?.id).toBe('c1');
  await userEvent.keyboard('{End}');
  expect(document.activeElement?.id).toBe('g');
  await userEvent.keyboard('{ArrowUp}{Home}');
  expect(document.activeElement?.id).toBe('a');
});

test('right opens a closed node then enters it and left climbs back out', async () => {
  const root = mountTree();
  root.querySelector<HTMLElement>('#f')?.focus();
  await userEvent.keyboard('{ArrowRight}');
  expect(document.activeElement?.id).toBe('c1');
  await userEvent.keyboard('{ArrowLeft}');
  expect(document.activeElement?.id).toBe('f');
  await userEvent.keyboard('{ArrowLeft}');
  expect(root.querySelector('#f')?.getAttribute('aria-expanded')).toBe('false');

  root.querySelector<HTMLElement>('#g')?.focus();
  await userEvent.keyboard('{ArrowRight}');
  expect(root.querySelector('#g')?.getAttribute('aria-expanded')).toBe('true');
});

test('space follows a treeitem link', async () => {
  const root = mountTree();
  const click = vi.fn((event: Event) => {
    event.preventDefault();
  });
  root.querySelector<HTMLElement>('#a')?.addEventListener('click', click);
  root.querySelector<HTMLElement>('#a')?.focus();
  await userEvent.keyboard(' ');
  expect(click).toHaveBeenCalledOnce();
});
