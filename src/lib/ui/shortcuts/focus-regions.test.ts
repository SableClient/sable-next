import { afterEach, expect, test } from 'vitest';

import { cycleRegion, focusRegion } from './focus-regions';
import { registerGlobalShortcuts } from './global-shortcuts';

afterEach(() => {
  document.body.replaceChildren();
});

function mount(html: string): void {
  document.body.innerHTML = html;
}

const LAYOUT = `
  <div role="tree" data-focus-region="spaces">
    <a href="#a" role="treeitem" tabindex="-1">A</a>
    <a href="#b" role="treeitem" tabindex="0">B</a>
  </div>
  <div role="tree" data-focus-region="rooms">
    <a href="#c" role="treeitem" tabindex="0" id="room">C</a>
  </div>
  <div role="log" tabindex="0" id="timeline"></div>
  <div data-focus-region="composer"><div contenteditable="true" id="composer"></div></div>
  <aside data-focus-region="panel"><button id="panel">Close</button></aside>
`;

test('focusRegion lands on the roving tab stop of a tree', () => {
  mount(LAYOUT);
  expect(focusRegion('spaces')).toBe(true);
  expect(document.activeElement?.textContent).toBe('B');
  expect(focusRegion('rooms')).toBe(true);
  expect(document.activeElement?.id).toBe('room');
});

test('focusRegion targets the timeline log and the composer editor', () => {
  mount(LAYOUT);
  focusRegion('timeline');
  expect(document.activeElement?.id).toBe('timeline');
  focusRegion('composer');
  expect(document.activeElement?.id).toBe('composer');
});

test('focusRegion reports a missing region and leaves focus alone', () => {
  mount('<button id="x">x</button>');
  document.getElementById('x')?.focus();
  expect(focusRegion('panel')).toBe(false);
  expect(document.activeElement?.id).toBe('x');
});

test('cycleRegion walks the regions forward and wraps', () => {
  mount(LAYOUT);
  const seen: string[] = [];
  for (let i = 0; i < 6; i++) {
    cycleRegion(1);
    seen.push(document.activeElement?.id || document.activeElement?.textContent || '');
  }
  expect(seen).toEqual(['B', 'room', 'timeline', 'composer', 'panel', 'B']);
});

test('cycleRegion walks backward and wraps', () => {
  mount(LAYOUT);
  document.getElementById('room')?.focus();
  cycleRegion(-1);
  expect(document.activeElement?.textContent).toBe('B');
  cycleRegion(-1);
  expect(document.activeElement?.id).toBe('panel');
});

test('cycleRegion skips regions that are not rendered', () => {
  mount(LAYOUT.replace('<aside ', '<aside style="display:none" '));
  document.getElementById('composer')?.focus();
  cycleRegion(1);
  expect(document.activeElement?.textContent).toBe('B');
});

test('cycleRegion starts at the first region when focus is outside every region', () => {
  mount(`<button id="out">out</button>${LAYOUT}`);
  document.getElementById('out')?.focus();
  cycleRegion(1);
  expect(document.activeElement?.textContent).toBe('B');
});

test.each([
  ['F6', {}, 'navigation.nextRegion'],
  ['F6', { shiftKey: true }, 'navigation.previousRegion'],
  ['c', { altKey: true, shiftKey: true }, 'navigation.focusComposer'],
  ['t', { altKey: true, shiftKey: true }, 'navigation.focusTimeline'],
  ['r', { altKey: true, shiftKey: true }, 'navigation.focusRoomList'],
  ['s', { altKey: true, shiftKey: true }, 'navigation.focusSpaces'],
] as const)('%s with %j fires %s from inside the composer', (key, init, id) => {
  const calls: string[] = [];
  const stop = registerGlobalShortcuts({ [id]: () => calls.push(id) });
  mount('<div contenteditable="true" id="e"></div>');
  document
    .getElementById('e')
    ?.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true, ...init }));
  stop();
  expect(calls).toEqual([id]);
});
