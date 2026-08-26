const LONG_PRESS_MS = 450;
const LONG_PRESS_SLOP_PX = 10;

export interface LongPressOptions {
  enabled?: () => boolean;
  stopPropagation?: boolean;
  onPress: () => void;
}

export class LongPress {
  fired = $state(false);
  touch = $state(false);

  #timer: ReturnType<typeof setTimeout> | undefined;
  #origin: { x: number; y: number } | null = null;

  constructor(private readonly options: LongPressOptions) {}

  start = (event: PointerEvent): void => {
    this.touch = event.pointerType !== 'mouse';
    if (this.options.stopPropagation) event.stopPropagation();
    if (event.pointerType === 'mouse') return;
    if (this.options.enabled && !this.options.enabled()) return;

    this.fired = false;
    this.#origin = { x: event.clientX, y: event.clientY };
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#origin = null;
      this.fired = true;
      this.options.onPress();
    }, LONG_PRESS_MS);
  };

  move = (event: PointerEvent): void => {
    if (this.options.stopPropagation) event.stopPropagation();
    if (!this.#origin) return;

    const moved =
      Math.abs(event.clientX - this.#origin.x) > LONG_PRESS_SLOP_PX ||
      Math.abs(event.clientY - this.#origin.y) > LONG_PRESS_SLOP_PX;
    if (moved) this.end();
  };

  end = (event?: PointerEvent): void => {
    if (this.options.stopPropagation) event?.stopPropagation();
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
    this.#origin = null;
  };

  cancel(): void {
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
