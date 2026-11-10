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

const feed = `<article id="a"><button id="a1">a1</button></article>
<article id="b"><button id="b1">b1</button></article>
<article id="c"><button id="c1">c1</button></article>
<article id="d"><button id="d1">d1</button></article>`;

test('contain parks controls inside other items and releases them with focus', async () => {
  const root = mount(feed, { orientation: 'vertical', selector: 'article', contain: 'button' });
  expect(tabStops(root).map((stop) => stop.id)).toEqual(['a']);
  root.querySelector<HTMLElement>('#a')?.focus();
  await userEvent.keyboard('{ArrowDown}');
  expect(document.activeElement?.id).toBe('b');
  root.querySelector<HTMLElement>('#b1')?.focus();
  expect(tabStops(root).map((stop) => stop.id)).toEqual(['b', 'b1']);
  root.querySelector<HTMLElement>('#b')?.focus();
  await Promise.resolve();
  expect(tabStops(root).map((stop) => stop.id)).toEqual(['b']);
});

test('page keys jump by the page size and clamp to the ends', async () => {
  const root = mount(feed, { orientation: 'vertical', selector: 'article', page: 2 });
  root.querySelector<HTMLElement>('#a')?.focus();
  await userEvent.keyboard('{PageDown}');
  expect(document.activeElement?.id).toBe('c');
  await userEvent.keyboard('{PageDown}');
  expect(document.activeElement?.id).toBe('d');
  await userEvent.keyboard('{PageUp}');
  expect(document.activeElement?.id).toBe('b');
});

test('onBoundary receives moves past the rendered items and Home or End', async () => {
  const onBoundary = vi.fn();
  const root = mount(feed, { orientation: 'vertical', selector: 'article', onBoundary });
  root.querySelector<HTMLElement>('#a')?.focus();
  await userEvent.keyboard('{ArrowUp}');
  expect(onBoundary).toHaveBeenLastCalledWith('start', root.querySelector('#a'), 1);
  await userEvent.keyboard('{End}');
  expect(onBoundary).toHaveBeenLastCalledWith('end', root.querySelector('#a'), Infinity);
  await userEvent.keyboard('{ArrowDown}');
  expect(document.activeElement?.id).toBe('b');
});

test('initial picks the first tab stop', () => {
  const root = mount(feed, {
    orientation: 'vertical',
    selector: 'article',
    contain: 'button',
    initial: (items) => items.at(-1),
  });
  expect(tabStops(root).map((stop) => stop.id)).toEqual(['d']);
});

test('hidden items are skipped and never become the tab stop', async () => {
  const root = mount(
    '<button id="a" hidden>a</button><button id="b">b</button><button id="c" hidden>c</button><button id="d">d</button>'
  );
  expect(tabStops(root).map((stop) => stop.id)).toEqual(['b']);
  root.querySelector<HTMLElement>('#b')?.focus();
  await userEvent.keyboard('{ArrowRight}');
  expect(document.activeElement?.id).toBe('d');
  await userEvent.keyboard('{Home}');
  expect(document.activeElement?.id).toBe('b');
});

test('a change in a long list does not check the visibility of every item', async () => {
  const root = mount(
    Array.from({ length: 200 }, (_, at) => `<button id="i${at}">${at}</button>`).join('')
  );
  const check = vi.spyOn(HTMLElement.prototype, 'checkVisibility');
  root.append(document.createElement('button'));
  await vi.waitFor(() => {
    expect(root.lastElementChild?.getAttribute('tabindex')).toBe('-1');
  });
  expect(check).not.toHaveBeenCalled();
  check.mockRestore();
});
