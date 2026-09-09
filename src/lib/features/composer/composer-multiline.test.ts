// @vitest-environment happy-dom

import { expect, test } from 'vitest';

import { isMultiline } from './composer-multiline';

interface Harness {
  row: HTMLElement;
  before: HTMLElement;
  after: HTMLElement;
  editable: HTMLElement;
  measurer: HTMLElement;
}

const CHARACTERS_PER_PIXEL = 10;

function harness(rowWidth = 300, buttonWidth = 40): Harness {
  const row = document.createElement('div');
  const before = document.createElement('div');
  const after = document.createElement('div');
  const field = document.createElement('div');
  const editable = document.createElement('div');
  const measurer = document.createElement('div');

  field.append(editable);
  row.append(before, field, after);
  document.body.append(row, measurer);

  Object.defineProperty(row, 'clientWidth', { value: rowWidth });
  for (const button of [before, after]) {
    Object.defineProperty(button, 'offsetWidth', { value: buttonWidth });
  }

  Object.defineProperty(measurer, 'scrollHeight', {
    get(this: HTMLElement) {
      const width = Number.parseFloat(this.style.width);
      const length = this.textContent.length;
      if (Number.isNaN(width)) return 20;
      return 20 * Math.ceil(length / (width / CHARACTERS_PER_PIXEL));
    },
  });

  return { row, before, after, editable, measurer };
}

function measure(text: string, overrides: Partial<Harness> = {}): boolean {
  return isMultiline({ text, ...harness(), ...overrides });
}

test('a newline makes the layout multiline whatever the width', () => {
  expect(measure('a\nb')).toBe(true);
});

test('an empty composer stays inline', () => {
  expect(measure('')).toBe(false);
});

test('text that fits beside the buttons stays inline', () => {
  expect(measure('a'.repeat(20))).toBe(false);
});

test('text too wide for the space left by the buttons goes multiline', () => {
  expect(measure('a'.repeat(30))).toBe(true);
});

test('a trailing space counts towards the width', () => {
  expect(measure(`${'a'.repeat(21)} `)).toBe(true);
});

test('a row with no width yet stays inline', () => {
  expect(measure('a'.repeat(100), harness(0))).toBe(false);
});
