// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest';

import type { LayoutRef } from '#lib/spaces/sidebar-layout.js';

import {
  dropInstructionAt,
  railDraggable,
  railDropTarget,
  railMonitor,
  type RailDropState,
} from './space-rail-dnd.js';

describe('dropInstructionAt', () => {
  it('splits a row that can hold children into three', () => {
    expect(dropInstructionAt(2, 40, true)).toBe('above');
    expect(dropInstructionAt(20, 40, true)).toBe('into');
    expect(dropInstructionAt(38, 40, true)).toBe('below');
  });

  it('leaves no dead band where a child cannot go', () => {
    const instructions = Array.from({ length: 41 }, (_, offset) =>
      dropInstructionAt(offset, 40, false)
    );

    expect(new Set(instructions)).toEqual(new Set(['above', 'below']));
  });

  it('answers for a pointer past either edge', () => {
    expect(dropInstructionAt(-8, 40, true)).toBe('above');
    expect(dropInstructionAt(64, 40, true)).toBe('below');
  });

  it('answers for a row that has not been laid out', () => {
    expect(dropInstructionAt(0, 0, true)).toBe('above');
  });
});

describe('the rail drag protocol', () => {
  function dragEvent(type: string, clientY = 0): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
      clientY: { value: clientY },
      dataTransfer: { value: { setData: () => undefined, effectAllowed: '', dropEffect: '' } },
      relatedTarget: { value: null, writable: true },
    });

    return event;
  }

  function mount(height: number) {
    const scroll = document.createElement('div');
    const source = document.createElement('div');
    const target = document.createElement('div');
    scroll.append(source, target);
    document.body.append(scroll);
    for (const element of [source, target]) {
      element.getBoundingClientRect = () =>
        ({ top: 0, height, bottom: height }) as unknown as DOMRect;
    }

    return { scroll, source, target };
  }

  afterEach(() => {
    document.body.replaceChildren();
  });

  it('carries the dragged entry from dragstart to drop', () => {
    const { scroll, source, target } = mount(40);
    const dropped: unknown[] = [];
    const states: (RailDropState | null)[] = [];
    const cleanups = [
      railMonitor((from, to, instruction) => dropped.push({ from, to, instruction }))(scroll),
      railDraggable({ kind: 'space', roomId: '!a' }, () => undefined)(source),
      railDropTarget({ kind: 'space', roomId: '!b' }, true, (state) => states.push(state))(target),
    ];

    source.dispatchEvent(dragEvent('dragstart'));
    target.dispatchEvent(dragEvent('dragover', 20));
    expect(states.at(-1)).toEqual({ ref: { kind: 'space', roomId: '!b' }, instruction: 'into' });

    target.dispatchEvent(dragEvent('drop', 20));
    expect(dropped).toEqual([
      {
        from: { kind: 'space', roomId: '!a' },
        to: { kind: 'space', roomId: '!b' },
        instruction: 'into',
      },
    ]);

    for (const cleanup of cleanups) cleanup?.();
  });

  it('ignores a target with no drag in progress, and the dragged entry itself', () => {
    const { scroll, source, target } = mount(40);
    const dropped: unknown[] = [];
    const ref = { kind: 'space', roomId: '!a' } as const;
    const cleanups = [
      railMonitor((from, to, instruction) => dropped.push({ from, to, instruction }))(scroll),
      railDraggable(ref, () => undefined)(source),
      railDropTarget(ref, true, () => undefined)(target),
    ];

    target.dispatchEvent(dragEvent('drop', 20));
    expect(dropped).toEqual([]);

    source.dispatchEvent(dragEvent('dragstart'));
    target.dispatchEvent(dragEvent('drop', 20));
    expect(dropped).toEqual([]);

    for (const cleanup of cleanups) cleanup?.();
  });

  it('forgets the drag when it ends', () => {
    const { scroll, source, target } = mount(40);
    const dragging: (LayoutRef | null)[] = [];
    const dropped: unknown[] = [];
    const cleanups = [
      railMonitor((from, to, instruction) => dropped.push({ from, to, instruction }))(scroll),
      railDraggable({ kind: 'space', roomId: '!a' }, (next) => dragging.push(next))(source),
      railDropTarget({ kind: 'space', roomId: '!b' }, true, () => undefined)(target),
    ];

    source.dispatchEvent(dragEvent('dragstart'));
    source.dispatchEvent(dragEvent('dragend'));
    expect(dragging).toEqual([{ kind: 'space', roomId: '!a' }, null]);

    target.dispatchEvent(dragEvent('drop', 20));
    expect(dropped).toEqual([]);

    for (const cleanup of cleanups) cleanup?.();
  });

  it('scrolls the rail while a drag sits at its edge', async () => {
    const { scroll, source, target } = mount(40);
    Object.defineProperty(scroll, 'getBoundingClientRect', {
      value: () => ({ top: 0, height: 100, bottom: 100 }) as unknown as DOMRect,
    });
    scroll.scrollTop = 50;
    const cleanups = [
      railMonitor(() => undefined)(scroll),
      railDraggable({ kind: 'space', roomId: '!a' }, () => undefined)(source),
      railDropTarget({ kind: 'space', roomId: '!b' }, true, () => undefined)(target),
    ];

    source.dispatchEvent(dragEvent('dragstart'));
    target.dispatchEvent(dragEvent('dragover', 96));
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(scroll.scrollTop).toBeGreaterThan(50);

    for (const cleanup of cleanups) cleanup?.();
  });

  it('forgets a drag whose source is destroyed mid-flight', () => {
    const { scroll, source, target } = mount(40);
    const dragging: (LayoutRef | null)[] = [];
    const dropped: unknown[] = [];
    const cleanups = [
      railMonitor((from, to, instruction) => dropped.push({ from, to, instruction }))(scroll),
      railDropTarget({ kind: 'space', roomId: '!b' }, true, () => undefined)(target),
    ];
    const release = railDraggable({ kind: 'space', roomId: '!a' }, (next) => dragging.push(next))(
      source
    );

    source.dispatchEvent(dragEvent('dragstart'));
    release?.();

    expect(dragging).toEqual([{ kind: 'space', roomId: '!a' }, null]);
    target.dispatchEvent(dragEvent('drop', 20));
    expect(dropped).toEqual([]);

    for (const cleanup of cleanups) cleanup?.();
  });

  it('keeps the indicator when the pointer crosses from one row to the next', () => {
    const { scroll, source, target } = mount(40);
    const second = document.createElement('div');
    second.getBoundingClientRect = () => ({ top: 0, height: 40, bottom: 40 }) as unknown as DOMRect;
    scroll.append(second);
    const states: (RailDropState | null)[] = [];
    const cleanups = [
      railMonitor(() => undefined)(scroll),
      railDraggable({ kind: 'space', roomId: '!a' }, () => undefined)(source),
      railDropTarget({ kind: 'space', roomId: '!b' }, true, (state) => states.push(state))(target),
      railDropTarget({ kind: 'space', roomId: '!c' }, true, (state) => states.push(state))(second),
    ];

    source.dispatchEvent(dragEvent('dragstart'));
    target.dispatchEvent(dragEvent('dragover', 20));
    second.dispatchEvent(dragEvent('dragover', 20));
    target.dispatchEvent(dragEvent('dragleave'));

    expect(states.at(-1)).toEqual({ ref: { kind: 'space', roomId: '!c' }, instruction: 'into' });

    for (const cleanup of cleanups) cleanup?.();
  });
});
