import { hapticFeedback } from '#lib/platform/haptics.js';
import { armTrailingClickSwallow, touchActive } from '#lib/ui/trailing-click.js';

export const LONG_PRESS_MS = 600;
export const SCHEDULE_PRESS_MS = 800;
const LONG_PRESS_SLOP_PX = 10;

export interface LongPressOptions {
  enabled?: () => boolean;
  stopPropagation?: boolean;
  delayMs?: number;
  onPress: (event: MouseEvent) => void;
}

export function touchContextMenu(event: MouseEvent): boolean {
  const kind = (event as Partial<PointerEvent>).pointerType;
  return kind === 'touch' || kind === 'pen' || (!kind && touchActive());
}

export function mouseContextMenu<E extends MouseEvent>(
  handler: (event: E) => void
): (event: E) => void {
  return (event) => {
    if (touchContextMenu(event)) {
      event.preventDefault();
      return;
    }
    handler(event);
  };
}

export function longPress(options: LongPressOptions): (node: Element) => () => void {
  return (node) => {
    const press = new LongPress(options);
    const listeners = [
      ['pointerdown', press.start],
      ['pointermove', press.move],
      ['pointerup', press.lift],
      ['pointercancel', press.cancelled],
      ['pointerleave', press.end],
      ['contextmenu', press.contextMenu],
    ] as const;
    for (const [type, handler] of listeners) node.addEventListener(type, handler as EventListener);
    return () => {
      press.cancel();
      for (const [type, handler] of listeners) {
        node.removeEventListener(type, handler as EventListener);
      }
    };
  };
}

export class LongPress {
  fired = $state(false);
  touch = $state(false);
  pressing = $state(false);

  #timer: ReturnType<typeof setTimeout> | undefined;
  #origin: { x: number; y: number } | null = null;
  #held = false;
  #menuSeen = false;

  constructor(private readonly options: LongPressOptions) {}

  get pending(): boolean {
    return this.#timer !== undefined;
  }

  start = (event: PointerEvent): void => {
    if (this.options.stopPropagation) event.stopPropagation();
    if (!event.isPrimary) return;
    this.cancel();
    this.touch = event.pointerType !== 'mouse';
    this.fired = false;
    if (event.pointerType === 'mouse') return;
    if (this.options.enabled && !this.options.enabled()) return;

    this.pressing = true;
    this.#held = true;
    this.#origin = { x: event.clientX, y: event.clientY };
    this.#timer = setTimeout(() => {
      this.fire(event);
    }, this.options.delayMs ?? LONG_PRESS_MS);
  };

  fire(event: MouseEvent): void {
    this.cancel();
    if (this.options.enabled && !this.options.enabled()) return;
    this.fired = true;
    hapticFeedback('medium');
    armTrailingClickSwallow();
    this.options.onPress(event);
  }

  move = (event: PointerEvent): void => {
    if (this.options.stopPropagation) event.stopPropagation();
    if (!event.isPrimary) return;
    if (!this.#origin) return;

    const moved =
      Math.abs(event.clientX - this.#origin.x) > LONG_PRESS_SLOP_PX ||
      Math.abs(event.clientY - this.#origin.y) > LONG_PRESS_SLOP_PX;
    if (moved) {
      this.#held = false;
      this.end();
    }
  };

  lift = (event: PointerEvent): void => {
    if (!event.isPrimary) return;
    this.#held = false;
    this.end(event);
  };

  contextMenu = (event: MouseEvent): void => {
    if (!this.#held || !touchContextMenu(event)) return;
    if (this.pending) this.#menuSeen = true;
    else this.fire(event);
  };

  cancelled = (event: PointerEvent): void => {
    if (!event.isPrimary) return;
    this.end(event);
    if (this.#held && this.#menuSeen) this.fire(event);
  };

  end = (event?: PointerEvent): void => {
    if (this.options.stopPropagation) event?.stopPropagation();
    if (event && !event.isPrimary) return;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#origin = null;
    this.pressing = false;
  };

  cancel(): void {
    this.#held = false;
    this.#menuSeen = false;
    this.end();
  }
}
