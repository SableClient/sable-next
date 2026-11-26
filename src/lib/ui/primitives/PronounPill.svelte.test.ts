// @vitest-environment happy-dom

import { render } from '@testing-library/svelte';
import { tick } from 'svelte';
import { afterEach, beforeEach, expect, test, vi } from 'vitest';

import { preferences } from '#lib/settings/preferences.svelte.js';

import PronounPill from './PronounPill.svelte';

const PILL_WIDTH_PER_CHAR = 10;
const pronouns = [
  { summary: 'he/him', language: null },
  { summary: 'she/her', language: null },
  { summary: 'they/them', language: null },
];

let containerWidth = 0;
let resizeCallbacks: (() => void)[] = [];

beforeEach(() => {
  containerWidth = 0;
  resizeCallbacks = [];
  vi.stubGlobal(
    'ResizeObserver',
    class {
      constructor(callback: () => void) {
        resizeCallbacks.push(callback);
      }
      observe() {}
      disconnect() {}
    }
  );
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (
    this: HTMLElement
  ) {
    const width = this.classList.contains('pronoun-pill-container')
      ? containerWidth
      : (this.dataset.text?.length ?? 0) * PILL_WIDTH_PER_CHAR;
    return { width } as DOMRect;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  preferences.pronounPillLimit = '3';
});

async function renderFitted(width: number) {
  containerWidth = width;
  const view = render(PronounPill, { pronouns, pillClass: 'test-pill' });
  await tick();
  return view;
}

function shown(container: HTMLElement) {
  return Array.from(container.querySelectorAll('.pronoun-pill-row > .pronoun-pill'), (pill) =>
    pill.textContent.trim()
  );
}

// he/him = 60, she/her = 70, they/them = 90, "+3" probe = 20

test('shows every pronoun without a +N pill when they all fit', async () => {
  const { container } = await renderFitted(300);
  expect(shown(container)).toEqual(['he/him', 'she/her', 'they/them']);
});

test('shows as many whole pronouns as fit, followed by a +N pill for the rest', async () => {
  const { container } = await renderFitted(200);
  expect(shown(container)).toEqual(['he/him', 'she/her', '+1']);
});

test('keeps at least one pronoun when only one and the +N pill fit', async () => {
  const { container } = await renderFitted(100);
  expect(shown(container)).toEqual(['he/him', '+2']);
});

test('shows no pills at all when the first pronoun and the +N pill do not fit', async () => {
  const { container } = await renderFitted(70);
  expect(shown(container)).toEqual([]);
});

test('re-fits when the available width changes', async () => {
  const { container } = await renderFitted(300);
  expect(shown(container)).toHaveLength(3);

  containerWidth = 100;
  resizeCallbacks.forEach((callback) => {
    callback();
  });
  await tick();
  expect(shown(container)).toEqual(['he/him', '+2']);

  containerWidth = 300;
  resizeCallbacks.forEach((callback) => {
    callback();
  });
  await tick();
  expect(shown(container)).toEqual(['he/him', 'she/her', 'they/them']);
});

test('always adds a +N pill for pronouns beyond the configured limit', async () => {
  preferences.pronounPillLimit = '1';
  const { container } = await renderFitted(300);
  expect(shown(container)).toEqual(['he/him', '+2']);
});

test('showAll lists every pronoun regardless of the limit and width', async () => {
  preferences.pronounPillLimit = '1';
  containerWidth = 100;
  const { container } = render(PronounPill, { pronouns, showAll: true });
  await tick();
  expect(shown(container)).toEqual(['he/him', 'she/her', 'they/them']);
});

test('measuring copies are hidden from assistive tech and carry no text nodes', async () => {
  const { container } = await renderFitted(300);
  const sizer = container.querySelector('.pronoun-pill-sizer');
  expect(sizer).toHaveAttribute('aria-hidden', 'true');
  expect(sizer?.textContent).toBe('');
  expect(container.querySelector('.pronoun-pill-probe')).toHaveAttribute('aria-hidden', 'true');
});

test('applies pillClass to visible pills only', async () => {
  const { container } = await renderFitted(300);
  expect(container.querySelectorAll('.test-pill')).toHaveLength(3);
  expect(container.querySelectorAll('.pronoun-pill-sizer .test-pill')).toHaveLength(0);
});
