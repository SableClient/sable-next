import { onDestroy } from 'svelte';

export interface UnsavedGuard {
  dirty: () => boolean;
  ask: (proceed: () => void) => void;
}

const guards = new Set<UnsavedGuard>();

export function holdUnsaved(guard: UnsavedGuard): void {
  guards.add(guard);
  onDestroy(() => {
    guards.delete(guard);
  });
}

export function leaveUnlessUnsaved(proceed: () => void): void {
  const blocking = [...guards].find((guard) => guard.dirty());
  if (blocking) blocking.ask(proceed);
  else proceed();
}
