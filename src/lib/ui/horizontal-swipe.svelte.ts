import {
  finishSwipeGesture,
  startSwipeGesture,
  updateSwipeGesture,
  type SwipeGesture,
  type SwipeResult,
} from './swipe-gesture.js';

export class HorizontalSwipe {
  dragging = $state(false);
  #gesture: SwipeGesture | undefined;
  #position = 0;

  get position(): number {
    return this.#position;
  }

  get active(): boolean {
    return this.#gesture !== undefined;
  }

  start(event: TouchEvent, startPosition = 0): boolean {
    const gesture = startSwipeGesture(event, startPosition);
    if (!gesture) return false;
    this.#gesture = gesture;
    this.#position = startPosition;
    this.dragging = false;
    return true;
  }

  move(event: TouchEvent, clamp?: (position: number) => number): number | undefined {
    const gesture = this.#gesture;
    if (!gesture) return undefined;
    const update = updateSwipeGesture(gesture, event);
    if (!update || update.mode !== 'horizontal') return undefined;
    this.dragging = true;
    const position = gesture.startPosition + update.distanceX;
    this.#position = clamp ? clamp(position) : position;
    return this.#position;
  }

  finish(cancelled: boolean): SwipeResult | undefined {
    const gesture = this.#gesture;
    const dragged = this.dragging;
    this.cancel();
    if (!gesture || !dragged) return undefined;
    return finishSwipeGesture(gesture, this.#position, cancelled);
  }

  cancel(): void {
    this.#gesture = undefined;
    this.dragging = false;
  }
}
