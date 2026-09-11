import { getContext, setContext } from 'svelte';

export interface ActionMenuSurface {
  readonly sheet: boolean;
  close: () => void;
}

const key = Symbol('action-menu');

const anchored: ActionMenuSurface = {
  sheet: false,
  close: () => {},
};

export function setActionMenuSurface(surface: ActionMenuSurface): void {
  setContext(key, surface);
}

export function useActionMenuSurface(): ActionMenuSurface {
  return getContext<ActionMenuSurface | undefined>(key) ?? anchored;
}
