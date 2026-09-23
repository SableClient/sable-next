export type ToastAction = { label: string; run: () => void };

export type Toast = {
  id: number;
  message: string;
  tone: 'error' | 'info';
  action?: ToastAction;
};

export type UndoOptions = {
  label: string;
  onUndo: () => void;
  onClose?: () => void;
};

const DISMISS_AFTER_MS = 5_000;
const UNDO_AFTER_MS = 8_000;

export class ToastStore {
  items = $state<Toast[]>([]);
  #nextId = 1;
  #timers = new SvelteMap<number, ReturnType<typeof setTimeout>>();
  /* eslint-disable svelte/prefer-svelte-reactivity */
  #delays = new Map<number, number>();
  #onClose = new Map<number, () => void>();
  /* eslint-enable svelte/prefer-svelte-reactivity */

  error(message: string): number {
    return this.#push({ message, tone: 'error' }, DISMISS_AFTER_MS);
  }

  info(message: string): number {
    return this.#push({ message, tone: 'info' }, DISMISS_AFTER_MS);
  }

  undoable(message: string, { label, onUndo, onClose }: UndoOptions): number {
    const id = this.#push(
      {
        message,
        tone: 'info',
        action: {
          label,
          run: () => {
            this.#onClose.delete(id);
            this.dismiss(id);
            onUndo();
          },
        },
      },
      UNDO_AFTER_MS
    );
    if (onClose) this.#onClose.set(id, onClose);
    return id;
  }

  hold(id: number): void {
    const timer = this.#timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.#timers.delete(id);
  }

  release(id: number): void {
    const delay = this.#delays.get(id);
    if (delay === undefined || this.#timers.has(id)) return;
    this.#schedule(id, delay);
  }

  dismiss(id: number): void {
    this.hold(id);
    this.#delays.delete(id);
    this.items = this.items.filter((toast) => toast.id !== id);
    const onClose = this.#onClose.get(id);
    this.#onClose.delete(id);
    onClose?.();
  }

  #push(toast: Omit<Toast, 'id'>, delay: number): number {
    const id = this.#nextId++;
    this.items = [...this.items, { id, ...toast }];
    this.#delays.set(id, delay);
    this.#schedule(id, delay);
    return id;
  }

  #schedule(id: number, delay: number): void {
    this.#timers.set(
      id,
      setTimeout(() => {
        this.dismiss(id);
      }, delay)
    );
  }
}

export const toasts = new ToastStore();
import { SvelteMap } from 'svelte/reactivity';
