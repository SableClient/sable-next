// @vitest-environment happy-dom

import { afterEach, expect, test } from 'vitest';

import { OutlineTracker } from './settings-outline.svelte.js';

const HEADINGS = [
  { id: 'one', label: 'One', top: 100 },
  { id: 'two', label: 'Two', top: 600 },
  { id: 'three', label: 'Three', top: 1200 },
];

function rect(top: number): DOMRect {
  return { top, bottom: top, left: 0, right: 0, width: 0, height: 0, x: 0, y: top } as DOMRect;
}

function mountScroller(): HTMLElement {
  const scroller = document.createElement('div');
  Object.defineProperty(scroller, 'clientHeight', { value: 400 });
  Object.defineProperty(scroller, 'scrollHeight', { value: 2000 });
  scroller.getBoundingClientRect = () => rect(0);
  scroller.scrollTo = ((options: ScrollToOptions) => {
    scroller.scrollTop = options.top ?? 0;
  }) as typeof scroller.scrollTo;

  for (const { id, label, top } of HEADINGS) {
    const section = document.createElement('section');
    const heading = document.createElement('h2');
    heading.id = id;
    heading.dataset.settingsOutline = '';
    heading.textContent = label;
    section.getBoundingClientRect = () => rect(top - scroller.scrollTop);
    heading.getBoundingClientRect = () => rect(top - scroller.scrollTop);
    section.append(heading);
    scroller.append(section);
  }

  const hidden = document.createElement('h2');
  hidden.id = 'not-outlined';
  hidden.textContent = 'Screen reader only';
  scroller.append(hidden);

  document.body.append(scroller);
  return scroller;
}

function scrollTo(scroller: HTMLElement, top: number): Promise<void> {
  scroller.scrollTop = top;
  scroller.dispatchEvent(new Event('scroll'));
  return new Promise((resolve) => {
    requestAnimationFrame(() => {
      resolve();
    });
  });
}

afterEach(() => {
  document.body.replaceChildren();
});

test('lists only the headings marked for the outline', () => {
  const outline = new OutlineTracker();
  const release = outline.track(mountScroller());

  expect(outline.entries).toEqual([
    { id: 'one', label: 'One' },
    { id: 'two', label: 'Two' },
    { id: 'three', label: 'Three' },
  ]);
  expect(outline.activeId).toBe('one');
  release();
});

test('follows the heading that has passed the top quarter of the pane', async () => {
  const outline = new OutlineTracker();
  const scroller = mountScroller();
  const release = outline.track(scroller);

  await scrollTo(scroller, 550);
  expect(outline.activeId).toBe('two');

  await scrollTo(scroller, 1600);
  expect(outline.activeId).toBe('three');

  await scrollTo(scroller, 0);
  expect(outline.activeId).toBe('one');
  release();
});

test('keeps a jumped-to section current until the reader scrolls', async () => {
  const outline = new OutlineTracker();
  const scroller = mountScroller();
  const release = outline.track(scroller);

  outline.jump('three');
  expect(outline.activeId).toBe('three');
  expect(document.activeElement?.id).toBe('three');

  await scrollTo(scroller, 0);
  expect(outline.activeId).toBe('three');

  scroller.dispatchEvent(new Event('wheel'));
  await scrollTo(scroller, 0);
  expect(outline.activeId).toBe('one');
  release();
});

test('picks up headings that render after the pane mounts', async () => {
  const outline = new OutlineTracker();
  const scroller = mountScroller();
  const release = outline.track(scroller);

  const late = document.createElement('h2');
  late.id = 'four';
  late.dataset.settingsOutline = '';
  late.textContent = 'Four';
  late.getBoundingClientRect = () => rect(1800 - scroller.scrollTop);
  scroller.append(late);
  await Promise.resolve();

  expect(outline.entries.map((entry) => entry.id)).toEqual(['one', 'two', 'three', 'four']);
  release();
  expect(outline.entries).toEqual([]);
});
