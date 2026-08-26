import type { Attachment } from 'svelte/attachments';
import { on } from 'svelte/events';

export type DropEdge = 'above' | 'below';
export type DropInstruction = DropEdge | 'into';

const INTO_BAND = 0.3;

function listen(...unsubscribers: (() => void)[]): () => void {
  return () => {
    for (const unsubscribe of unsubscribers) unsubscribe();
  };
}

const SCROLL_EDGE_PX = 48;
const SCROLL_STEP_PX = 12;

export type DropState<T> = { item: T; instruction: DropInstruction };

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

export interface DropTargetOptions<T> {
  allowInto?: boolean;
  onState: (state: DropState<T> | null) => void;
  onDrop: (source: T, target: T, instruction: DropInstruction) => void;
}

export interface DragList<T> {
  draggable: (item: T, onDragging: (dragged: T | null) => void) => Attachment<HTMLElement>;
  dropTarget: (item: T, options: DropTargetOptions<T>) => Attachment<HTMLElement>;
  autoScroll: () => Attachment<HTMLElement>;
}

export function createDragList<T>(equals: (left: T, right: T) => boolean): DragList<T> {
  let dragged: T | null = null;
  let hovered: T | null = null;

  return {
    draggable(item, onDragging) {
      return (node) => {
        const start = (event: DragEvent): void => {
          dragged = item;
          onDragging(item);
          event.dataTransfer?.setData('text/plain', '');
          if (event.dataTransfer !== null) event.dataTransfer.effectAllowed = 'move';
        };
        const end = (): void => {
          dragged = null;
          hovered = null;
          onDragging(null);
        };

        node.draggable = true;
        const stopListening = listen(on(node, 'dragstart', start), on(node, 'dragend', end));

        return () => {
          node.draggable = false;
          stopListening();
          if (dragged !== null && equals(dragged, item)) end();
        };
      };
    },

    dropTarget(item, { allowInto = false, onState, onDrop }) {
      return (node) => {
        const instructionAt = (clientY: number): DropInstruction => {
          const box = node.getBoundingClientRect();

          return dropInstructionAt(clientY - box.top, box.height, allowInto);
        };

        const over = (event: DragEvent): void => {
          if (dragged === null || equals(dragged, item)) return;

          event.preventDefault();
          event.stopPropagation();
          if (event.dataTransfer !== null) event.dataTransfer.dropEffect = 'move';

          hovered = item;
          onState({ item, instruction: instructionAt(event.clientY) });
        };

        const leave = (): void => {
          if (hovered !== null && !equals(hovered, item)) return;

          hovered = null;
          onState(null);
        };

        const drop = (event: DragEvent): void => {
          const source = dragged;
          if (source === null || equals(source, item)) return;

          event.preventDefault();
          event.stopPropagation();
          hovered = null;
          onState(null);
          onDrop(source, item, instructionAt(event.clientY));
        };

        return listen(
          on(node, 'dragenter', over),
          on(node, 'dragover', over),
          on(node, 'dragleave', leave),
          on(node, 'drop', drop)
        );
      };
    },

    autoScroll() {
      return (node) => {
        let frame: number | null = null;
        let pointerY: number | null = null;

        const step = (): void => {
          frame = null;
          if (dragged === null || pointerY === null) return;

          const box = node.getBoundingClientRect();
          if (pointerY - box.top < SCROLL_EDGE_PX) {
            node.scrollTop -= SCROLL_STEP_PX;
          } else if (box.bottom - pointerY < SCROLL_EDGE_PX) {
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

        const stopListening = listen(
          on(node, 'dragover', track, { capture: true }),
          on(node, 'dragleave', left, { capture: true }),
          on(node, 'drop', stop, { capture: true }),
          on(document, 'dragend', stop)
        );

        return () => {
          stop();
          stopListening();
        };
      };
    },
  };
}
