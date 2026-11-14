import type { Attachment } from 'svelte/attachments';
import { on } from 'svelte/events';

import type { Corner } from './geometry.js';

export interface Point {
  x: number;
  y: number;
}

export interface GestureTarget {
  enabled: () => boolean;
  pan: (dx: number, dy: number) => void;
  zoom: (factor: number, anchor: Point) => void;
  startResize: (corner: Corner) => void;
  /** Movement since the resize started. */
  resize: (dx: number, dy: number) => void;
  active: (active: boolean) => void;
}

const WHEEL_LINE_PX = 16;
const WHEEL_ZOOM_RATE = 0.0015;

/**
 * Turns pointers and the wheel on the stage into pan, pinch and wheel zoom, and
 * corner resizes for descendants marked with `data-corner`. Points are relative
 * to the stage.
 */
export function cropGestures(target: GestureTarget): Attachment<HTMLElement> {
  return (node) => {
    const pointers = new Map<number, Point>();
    let resizing: { pointerId: number; start: Point } | null = null;

    const local = (event: PointerEvent | WheelEvent): Point => {
      const box = node.getBoundingClientRect();
      return { x: event.clientX - box.left, y: event.clientY - box.top };
    };

    const down = (event: PointerEvent): void => {
      if (!target.enabled() || event.button !== 0) return;
      node.setPointerCapture(event.pointerId);
      const corner = (event.target as Element).closest<HTMLElement>('[data-corner]')?.dataset
        .corner as Corner | undefined;
      if (corner) {
        resizing = { pointerId: event.pointerId, start: local(event) };
        target.startResize(corner);
      } else {
        pointers.set(event.pointerId, local(event));
      }
      target.active(true);
    };

    const move = (event: PointerEvent): void => {
      const point = local(event);
      if (resizing?.pointerId === event.pointerId) {
        target.resize(point.x - resizing.start.x, point.y - resizing.start.y);
        return;
      }
      const previous = pointers.get(event.pointerId);
      if (!previous) return;
      const other = [...pointers].find(([id]) => id !== event.pointerId)?.[1];
      if (other) {
        const before = Math.hypot(previous.x - other.x, previous.y - other.y);
        const after = Math.hypot(point.x - other.x, point.y - other.y);
        target.zoom(after / Math.max(1, before), {
          x: (point.x + other.x) / 2,
          y: (point.y + other.y) / 2,
        });
        target.pan((point.x - previous.x) / 2, (point.y - previous.y) / 2);
      } else {
        target.pan(point.x - previous.x, point.y - previous.y);
      }
      pointers.set(event.pointerId, point);
    };

    const up = (event: PointerEvent): void => {
      if (resizing?.pointerId === event.pointerId) resizing = null;
      pointers.delete(event.pointerId);
      target.active(pointers.size > 0 || resizing !== null);
    };

    const wheel = (event: WheelEvent): void => {
      if (!target.enabled()) return;
      event.preventDefault();
      const delta =
        event.deltaMode === WheelEvent.DOM_DELTA_LINE ? event.deltaY * WHEEL_LINE_PX : event.deltaY;
      target.zoom(Math.exp(-delta * WHEEL_ZOOM_RATE), local(event));
    };

    const off = [
      on(node, 'pointerdown', down),
      on(node, 'pointermove', move),
      on(node, 'pointerup', up),
      on(node, 'pointercancel', up),
      on(node, 'wheel', wheel, { passive: false }),
    ];
    return () => {
      for (const stop of off) stop();
    };
  };
}
