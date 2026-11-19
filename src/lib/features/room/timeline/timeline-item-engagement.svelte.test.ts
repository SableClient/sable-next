// @vitest-environment happy-dom

import { afterEach, expect, test, vi } from 'vitest';

import { flushed } from '#lib/ui/flushed.js';

import { TimelineItemEngagement } from './timeline-item-engagement.svelte';

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

function setup(): {
  row: HTMLElement;
  inside: HTMLButtonElement;
  engagement: TimelineItemEngagement;
} {
  const row = document.createElement('article');
  const inside = document.createElement('button');
  row.append(inside);
  document.body.append(row);
  return { row, inside, engagement: new TimelineItemEngagement(() => row) };
}

test('pointer enter engages and pointer leave disengages', () => {
  const { engagement } = setup();
  engagement.engage(new PointerEvent('pointerenter'));
  expect(engagement.engaged).toBe(true);
  engagement.disengage(new PointerEvent('pointerleave'));
  expect(engagement.engaged).toBe(false);
});

test('a touch entering the row does not engage it', () => {
  const { engagement } = setup();
  engagement.engage(new PointerEvent('pointerenter', { pointerType: 'touch' }));
  expect(engagement.engaged).toBe(false);
});

test('focus moving within the row keeps it engaged', () => {
  const { inside, engagement } = setup();
  engagement.engaged = true;
  engagement.disengage(new FocusEvent('focusout', { relatedTarget: inside }));
  expect(engagement.engaged).toBe(true);
  engagement.disengage(new FocusEvent('focusout', { relatedTarget: null }));
  expect(engagement.engaged).toBe(false);
});

test('a held press keeps the row engaged until release lands outside it', async () => {
  const { inside, engagement } = setup();
  engagement.engage(new PointerEvent('pointerenter'));
  engagement.hold();
  await flushed();
  engagement.disengage(new PointerEvent('pointerleave'));
  expect(engagement.engaged).toBe(true);

  const under = vi.spyOn(document, 'elementFromPoint').mockReturnValue(inside);
  document.body.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  expect(engagement.engaged).toBe(true);

  engagement.hold();
  await flushed();
  under.mockReturnValue(document.body);
  document.body.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
  expect(engagement.engaged).toBe(false);
});
