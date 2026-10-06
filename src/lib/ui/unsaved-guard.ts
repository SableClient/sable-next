import { beforeNavigate, goto } from '$app/navigation';
import { onDestroy } from 'svelte';

export interface UnsavedGuard {
  dirty: () => boolean;
  ask: (proceed: () => void, stay?: () => void) => void;
}

const guards = new Set<UnsavedGuard>();

export function holdUnsaved(guard: UnsavedGuard): void {
  guards.add(guard);

  beforeNavigate((navigation) => {
    const { from, to } = navigation;
    if (navigation.willUnload || !to || from?.url.href === to.url.href) return;
    if (!guard.dirty()) return;

    navigation.cancel();
    const { delta, type } = navigation as { delta?: number; type: string };
    guard.ask(() => {
      if (type === 'popstate' && delta !== undefined) history.go(delta);
      else void goto(to.url);
    });
  });

  const warn = (event: BeforeUnloadEvent): void => {
    if (guard.dirty()) event.preventDefault();
  };
  addEventListener('beforeunload', warn);

  onDestroy(() => {
    guards.delete(guard);
    removeEventListener('beforeunload', warn);
  });
}

export function leaveUnlessUnsaved(proceed: () => void, stay?: () => void): void {
  const blocking = [...guards].find((guard) => guard.dirty());
  if (blocking) blocking.ask(proceed, stay);
  else proceed();
}
