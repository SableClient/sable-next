export type Toast = { id: number; message: string };

const DISMISS_AFTER_MS = 5_000;

export class ToastStore {
  items = $state<Toast[]>([]);
  #nextId = 1;
  #timers = new SvelteMap<number, ReturnType<typeof setTimeout>>();

  error(message: string): number {
    const id = this.#nextId++;
    this.items = [...this.items, { id, message }];
    this.#timers.set(
      id,
      setTimeout(() => {
        this.dismiss(id);
      }, DISMISS_AFTER_MS)
    );
    return id;
  }

  dismiss(id: number): void {
    const timer = this.#timers.get(id);
    if (timer !== undefined) clearTimeout(timer);
    this.#timers.delete(id);
    this.items = this.items.filter((toast) => toast.id !== id);
  }
}

export const toasts = new ToastStore();
import { SvelteMap } from 'svelte/reactivity';
