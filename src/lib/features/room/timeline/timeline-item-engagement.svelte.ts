import { on } from 'svelte/events';

export class TimelineItemEngagement {
  engaged = $state(false);
  #pressing = false;
  readonly #row: () => HTMLElement | null;

  constructor(row: () => HTMLElement | null) {
    this.#row = row;
  }

  hold(): void {
    this.#pressing = true;
    const release = (event: PointerEvent): void => {
      stopUp();
      stopCancel();
      this.#pressing = false;
      const under = document.elementFromPoint(event.clientX, event.clientY);
      if (!under || !this.#row()?.contains(under)) this.engaged = false;
    };
    const stopUp = on(window, 'pointerup', release, { capture: true });
    const stopCancel = on(window, 'pointercancel', release, { capture: true });
  }

  engage = (event: FocusEvent | PointerEvent): void => {
    // A finger has no hover, so the actions it would reveal vanish again on release.
    if (event instanceof PointerEvent && event.pointerType === 'touch') return;
    if (
      event instanceof FocusEvent &&
      event.target instanceof Element &&
      !event.target.matches(':focus-visible')
    )
      return;
    this.engaged = true;
  };

  disengage = (event: FocusEvent | PointerEvent): void => {
    if (this.#pressing) return;
    const row = this.#row();
    if (event instanceof FocusEvent && event.relatedTarget instanceof Node) {
      if (row?.contains(event.relatedTarget)) return;
    } else if (!(event instanceof FocusEvent) && row?.matches(':has(:focus-visible)')) {
      return;
    }
    this.engaged = false;
  };
}
