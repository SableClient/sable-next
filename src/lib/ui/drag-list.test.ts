// @vitest-environment happy-dom

import { afterEach, describe, expect, it } from 'vitest';

import {
  createDragList,
  dropInstructionAt,
  type DropInstruction,
  type DropState,
} from './drag-list.js';

type Ref = { kind: 'space'; roomId: string };

const refsEqual = (left: Ref, right: Ref): boolean => left.roomId === right.roomId;
const ref = (roomId: string): Ref => ({ kind: 'space', roomId });

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

describe('the drag protocol', () => {
  type Drop = { from: Ref; to: Ref; instruction: DropInstruction };

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
    const list = createDragList<Ref>(refsEqual);
    const dropped: Drop[] = [];
    const states: (DropState<Ref> | null)[] = [];
    const cleanups = [
      list.autoScroll()(scroll),
      list.draggable(ref('!a'), () => undefined)(source),
      list.dropTarget(ref('!b'), {
        allowInto: true,
        onState: (state) => states.push(state),
        onDrop: (from, to, instruction) => dropped.push({ from, to, instruction }),
      })(target),
    ];

    source.dispatchEvent(dragEvent('dragstart'));
    target.dispatchEvent(dragEvent('dragover', 20));
    expect(states.at(-1)).toEqual({ item: ref('!b'), instruction: 'into' });

    target.dispatchEvent(dragEvent('drop', 20));
    expect(dropped).toEqual([{ from: ref('!a'), to: ref('!b'), instruction: 'into' }]);

    for (const cleanup of cleanups) cleanup?.();
  });

  it('answers only an edge for a row that cannot take a child', () => {
    const { source, target } = mount(40);
    const list = createDragList<Ref>(refsEqual);
    const dropped: Drop[] = [];
    const cleanups = [
      list.draggable(ref('!a'), () => undefined)(source),
      list.dropTarget(ref('!b'), {
        onState: () => undefined,
        onDrop: (from, to, instruction) => dropped.push({ from, to, instruction }),
      })(target),
    ];

    source.dispatchEvent(dragEvent('dragstart'));
    target.dispatchEvent(dragEvent('drop', 20));

    expect(dropped.map((drop) => drop.instruction)).toEqual(['below']);

    for (const cleanup of cleanups) cleanup?.();
  });

  it('ignores a target with no drag in progress, and the dragged entry itself', () => {
    const { source, target } = mount(40);
    const list = createDragList<Ref>(refsEqual);
    const dropped: Drop[] = [];
    const cleanups = [
      list.draggable(ref('!a'), () => undefined)(source),
      list.dropTarget(ref('!a'), {
        allowInto: true,
        onState: () => undefined,
        onDrop: (from, to, instruction) => dropped.push({ from, to, instruction }),
      })(target),
    ];

    target.dispatchEvent(dragEvent('drop', 20));
    expect(dropped).toEqual([]);

    source.dispatchEvent(dragEvent('dragstart'));
    target.dispatchEvent(dragEvent('drop', 20));
    expect(dropped).toEqual([]);

    for (const cleanup of cleanups) cleanup?.();
  });

  it('forgets the drag when it ends', () => {
    const { source, target } = mount(40);
    const list = createDragList<Ref>(refsEqual);
    const dragging: (Ref | null)[] = [];
    const dropped: Drop[] = [];
    const cleanups = [
      list.draggable(ref('!a'), (next) => dragging.push(next))(source),
      list.dropTarget(ref('!b'), {
        allowInto: true,
        onState: () => undefined,
        onDrop: (from, to, instruction) => dropped.push({ from, to, instruction }),
      })(target),
    ];

    source.dispatchEvent(dragEvent('dragstart'));
    source.dispatchEvent(dragEvent('dragend'));
    expect(dragging).toEqual([ref('!a'), null]);

    target.dispatchEvent(dragEvent('drop', 20));
    expect(dropped).toEqual([]);

    for (const cleanup of cleanups) cleanup?.();
  });

  it('scrolls the container while a drag sits at its edge', async () => {
    const { scroll, source, target } = mount(40);
    const list = createDragList<Ref>(refsEqual);
    Object.defineProperty(scroll, 'getBoundingClientRect', {
      value: () => ({ top: 0, height: 100, bottom: 100 }) as unknown as DOMRect,
    });
    scroll.scrollTop = 50;
    const cleanups = [
      list.autoScroll()(scroll),
      list.draggable(ref('!a'), () => undefined)(source),
      list.dropTarget(ref('!b'), {
        allowInto: true,
        onState: () => undefined,
        onDrop: () => undefined,
      })(target),
    ];

    source.dispatchEvent(dragEvent('dragstart'));
    target.dispatchEvent(dragEvent('dragover', 96));
    await new Promise((resolve) => requestAnimationFrame(resolve));

    expect(scroll.scrollTop).toBeGreaterThan(50);

    for (const cleanup of cleanups) cleanup?.();
  });

  it('forgets a drag whose source is destroyed mid-flight', () => {
    const { source, target } = mount(40);
    const list = createDragList<Ref>(refsEqual);
    const dragging: (Ref | null)[] = [];
    const dropped: Drop[] = [];
    const cleanups = [
      list.dropTarget(ref('!b'), {
        allowInto: true,
        onState: () => undefined,
        onDrop: (from, to, instruction) => dropped.push({ from, to, instruction }),
      })(target),
    ];
    const release = list.draggable(ref('!a'), (next) => dragging.push(next))(source);

    source.dispatchEvent(dragEvent('dragstart'));
    release?.();

    expect(dragging).toEqual([ref('!a'), null]);
    target.dispatchEvent(dragEvent('drop', 20));
    expect(dropped).toEqual([]);

    for (const cleanup of cleanups) cleanup?.();
  });

  it('keeps the indicator when the pointer crosses from one row to the next', () => {
    const { scroll, source, target } = mount(40);
    const list = createDragList<Ref>(refsEqual);
    const second = document.createElement('div');
    second.getBoundingClientRect = () => ({ top: 0, height: 40, bottom: 40 }) as unknown as DOMRect;
    scroll.append(second);
    const states: (DropState<Ref> | null)[] = [];
    const target2 = {
      allowInto: true,
      onState: (s: DropState<Ref> | null) => states.push(s),
      onDrop: () => undefined,
    };
    const cleanups = [
      list.draggable(ref('!a'), () => undefined)(source),
      list.dropTarget(ref('!b'), target2)(target),
      list.dropTarget(ref('!c'), target2)(second),
    ];

    source.dispatchEvent(dragEvent('dragstart'));
    target.dispatchEvent(dragEvent('dragover', 20));
    second.dispatchEvent(dragEvent('dragover', 20));
    target.dispatchEvent(dragEvent('dragleave'));

    expect(states.at(-1)).toEqual({ item: ref('!c'), instruction: 'into' });

    for (const cleanup of cleanups) cleanup?.();
  });

  it('does not let a drag in one list reach the rows of another', () => {
    const { source, target } = mount(40);
    const rail = createDragList<Ref>(refsEqual);
    const lobby = createDragList<string>((left, right) => left === right);
    const states: (DropState<string> | null)[] = [];
    const dropped: string[] = [];
    const cleanups = [
      rail.draggable(ref('!a'), () => undefined)(source),
      lobby.dropTarget('!b', {
        onState: (state) => states.push(state),
        onDrop: (from) => dropped.push(from),
      })(target),
    ];

    source.dispatchEvent(dragEvent('dragstart'));
    target.dispatchEvent(dragEvent('dragover', 20));
    target.dispatchEvent(dragEvent('drop', 20));

    expect(states).toEqual([]);
    expect(dropped).toEqual([]);

    for (const cleanup of cleanups) cleanup?.();
  });
});
