export const DOUBLE_TAP_MS = 300;
const TAP_SLOP_PX = 10;
const DOUBLE_TAP_SLOP_PX = 24;
const TAP_TARGETS =
  'a, button, input, textarea, select, summary, video, audio, [role="button"], [contenteditable="true"]';

interface Tap {
  x: number;
  y: number;
  time: number;
}

function near(from: Tap, event: PointerEvent, slop: number): boolean {
  return Math.abs(event.clientX - from.x) <= slop && Math.abs(event.clientY - from.y) <= slop;
}

function tapAt(event: PointerEvent): Tap {
  return { x: event.clientX, y: event.clientY, time: event.timeStamp };
}

export class DoubleTap {
  #down: Tap | null = null;
  #last: Tap | null = null;

  constructor(private readonly onDoubleTap: () => void) {}

  down = (event: PointerEvent): void => {
    const onControl = event.target instanceof Element && event.target.closest(TAP_TARGETS);
    if (event.pointerType === 'mouse' || onControl) {
      this.cancel();
      return;
    }
    this.#down = tapAt(event);
  };

  up = (event: PointerEvent): void => {
    const down = this.#down;
    this.#down = null;
    if (!down || !near(down, event, TAP_SLOP_PX) || event.timeStamp - down.time > DOUBLE_TAP_MS) {
      this.#last = null;
      return;
    }

    const last = this.#last;
    if (last && down.time - last.time <= DOUBLE_TAP_MS && near(last, event, DOUBLE_TAP_SLOP_PX)) {
      this.#last = null;
      this.onDoubleTap();
      return;
    }
    this.#last = tapAt(event);
  };

  cancel = (): void => {
    this.#down = null;
    this.#last = null;
  };
}
