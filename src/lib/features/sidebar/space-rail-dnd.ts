import type { Attachment } from 'svelte/attachments';

import { refsEqual, type DropInstruction, type LayoutRef } from '#lib/spaces/sidebar-layout.js';

export type RailDropState = { ref: LayoutRef; instruction: DropInstruction };

const INTO_BAND = 0.3;

const SCROLL_EDGE_PX = 48;
const SCROLL_STEP_PX = 12;

let dragged: LayoutRef | null = null;
let hovered: LayoutRef | null = null;
let onDrop: ((source: LayoutRef, target: LayoutRef, instruction: DropInstruction) => void) | null =
  null;

export function dropInstructionAt(
  offsetY: number,
  height: number,
  allowInto: boolean
): DropInstruction {
  if (height <= 0) return 'above';

  const position = Math.min(Math.max(offsetY / height, 0), 1);
  if (!allowInto) return position < 0.5 ? 'above' : 'below';
  if (position < INTO_BAND) return 'above';
  if (position > 1 - INTO_BAND) return 'below';

  return 'into';
}

export function railDraggable(
  ref: LayoutRef,
  onDragging: (dragged: LayoutRef | null) => void
): Attachment<HTMLElement> {
  return (node) => {
    const start = (event: DragEvent): void => {
      dragged = ref;
      onDragging(ref);
      event.dataTransfer?.setData('text/plain', '');
      if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = 'move';
    };
    const end = (): void => {
      dragged = null;
      hovered = null;
      onDragging(null);
    };

    node.draggable = true;
    node.addEventListener('dragstart', start);
    node.addEventListener('dragend', end);

    return () => {
      node.draggable = false;
      node.removeEventListener('dragstart', start);
      node.removeEventListener('dragend', end);
      if (dragged !== null && refsEqual(dragged, ref)) end();
    };
  };
}

export function railDropTarget(
  ref: LayoutRef,
  allowInto: boolean,
  onDropState: (state: RailDropState | null) => void
): Attachment<HTMLElement> {
  return (node) => {
    const instructionAt = (clientY: number): DropInstruction => {
      const box = node.getBoundingClientRect();

      return dropInstructionAt(clientY - box.top, box.height, allowInto);
    };

    const over = (event: DragEvent): void => {
      if (dragged === null || refsEqual(dragged, ref)) return;

      event.preventDefault();
      event.stopPropagation();
      if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move';

      hovered = ref;
      onDropState({ ref, instruction: instructionAt(event.clientY) });
    };

    const leave = (): void => {
      if (hovered !== null && !refsEqual(hovered, ref)) return;

      hovered = null;
      onDropState(null);
    };

    const drop = (event: DragEvent): void => {
      const source = dragged;
      if (source === null || refsEqual(source, ref)) return;

      event.preventDefault();
      event.stopPropagation();
      hovered = null;
      onDropState(null);
      onDrop?.(source, ref, instructionAt(event.clientY));
    };

    node.addEventListener('dragenter', over);
    node.addEventListener('dragover', over);
    node.addEventListener('dragleave', leave);
    node.addEventListener('drop', drop);

    return () => {
      node.removeEventListener('dragenter', over);
      node.removeEventListener('dragover', over);
      node.removeEventListener('dragleave', leave);
      node.removeEventListener('drop', drop);
    };
  };
}

export function railMonitor(
  handler: (source: LayoutRef, target: LayoutRef, instruction: DropInstruction) => void
): Attachment<HTMLElement> {
  return (node) => {
    let frame: number | null = null;
    let pointerY: number | null = null;

    const step = (): void => {
      frame = null;
      if (dragged === null || pointerY === null) return;

      const box = node.getBoundingClientRect();
      const above = pointerY - box.top;
      const below = box.bottom - pointerY;
      if (above < SCROLL_EDGE_PX) {
        node.scrollTop -= SCROLL_STEP_PX;
      } else if (below < SCROLL_EDGE_PX) {
        node.scrollTop += SCROLL_STEP_PX;
      }

      frame = requestAnimationFrame(step);
    };

    const track = (event: DragEvent): void => {
      if (dragged === null) return;

      pointerY = event.clientY;
      frame ??= requestAnimationFrame(step);
    };

    const stop = (): void => {
      pointerY = null;
      if (frame !== null) cancelAnimationFrame(frame);
      frame = null;
    };

    const left = (event: DragEvent): void => {
      const entering = event.relatedTarget;
      if (entering instanceof Node && node.contains(entering)) return;

      stop();
    };

    onDrop = handler;
    node.addEventListener('dragover', track, { capture: true });
    node.addEventListener('dragleave', left, { capture: true });
    node.addEventListener('drop', stop, { capture: true });
    document.addEventListener('dragend', stop);

    return () => {
      stop();
      if (onDrop === handler) onDrop = null;
      node.removeEventListener('dragover', track, { capture: true });
      node.removeEventListener('dragleave', left, { capture: true });
      node.removeEventListener('drop', stop, { capture: true });
      document.removeEventListener('dragend', stop);
    };
  };
}
