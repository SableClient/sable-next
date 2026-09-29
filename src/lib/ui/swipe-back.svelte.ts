import { MOTION_MS, motionMs } from './motion.js';
import {
  finishSwipeGesture,
  startSwipeGesture,
  updateSwipeGesture,
  type SwipeGesture,
} from './swipe-gesture.js';

interface SwipeBackOptions {
  width: () => number;
  onDismiss: () => void;
  ignore?: string;
  slideOut?: boolean;
}

export class SwipeBack {
  offset = $state(0);
  swiping = $state(false);
  leaving = $state(false);
  settling = $state(false);
  #gesture: SwipeGesture | undefined;
  #timer: ReturnType<typeof setTimeout> | undefined;
  #options: SwipeBackOptions;

  constructor(options: SwipeBackOptions) {
    this.#options = options;
  }

  get moved(): boolean {
    return this.swiping || this.offset > 0 || this.leaving || this.settling;
  }

  get transform(): string | undefined {
    if (this.leaving) return 'translateX(100%)';
    return this.offset > 0 ? `translateX(${String(this.offset)}px)` : undefined;
  }

  start = (event: TouchEvent): void => {
    if (this.leaving) return;
    this.#clearTimer();
    this.settling = false;
    const target = event.target instanceof Element ? event.target : null;
    const { ignore } = this.#options;
    this.#gesture =
      ignore !== undefined && target?.closest(ignore) ? undefined : startSwipeGesture(event, 0);
  };

  move = (event: TouchEvent): void => {
    if (!this.#gesture) return;
    const update = updateSwipeGesture(this.#gesture, event);
    if (!update || update.mode !== 'horizontal') return;
    this.swiping = true;
    this.offset = Math.max(0, update.distanceX);
  };

  finish = (cancelled: boolean): void => {
    const active = this.#gesture;
    this.#gesture = undefined;
    this.swiping = false;
    if (!active) return;
    const offset = this.offset;
    const result = finishSwipeGesture(active, offset, cancelled);
    const dismissed =
      result.handled &&
      (result.direction === 'right' ||
        (result.direction === undefined && offset > this.#options.width() / 2));
    if (!dismissed) {
      this.#springBack();
      return;
    }
    if (this.#options.slideOut === false) {
      this.#options.onDismiss();
      return;
    }
    this.dismiss();
  };

  dismiss = (): void => {
    if (this.leaving) return;
    const duration = motionMs(MOTION_MS.medium);
    if (duration === 0) {
      this.offset = 0;
      this.#options.onDismiss();
      return;
    }
    this.#clearTimer();
    this.settling = false;
    this.leaving = true;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.#options.onDismiss();
    }, duration);
  };

  reset = (): void => {
    this.#clearTimer();
    this.#gesture = undefined;
    this.leaving = false;
    this.settling = false;
    this.swiping = false;
    this.offset = 0;
  };

  #springBack(): void {
    const moved = this.offset > 0;
    this.offset = 0;
    const duration = motionMs(MOTION_MS.medium);
    if (!moved || duration === 0) return;
    this.settling = true;
    this.#timer = setTimeout(() => {
      this.#timer = undefined;
      this.settling = false;
    }, duration);
  }

  #clearTimer(): void {
    if (this.#timer !== undefined) clearTimeout(this.#timer);
    this.#timer = undefined;
  }
}
