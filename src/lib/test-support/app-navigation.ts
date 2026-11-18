import { vi } from 'vitest';

import { page } from './app-state.js';

const listeners = new Set<() => void>();

type GotoOptions = { shallow?: boolean; replace?: boolean; state?: Record<string, unknown> };

export const goto = vi.fn((_href: string, options?: GotoOptions) => {
  Object.assign(page.state, options?.state);
  // The overlay back guard pops shallow entries with history.go, which would otherwise
  // pop the browser test runner's own page.
  if (options?.shallow && typeof history !== 'undefined' && 'pushState' in history) {
    if (options.replace) history.replaceState(history.state, '');
    else history.pushState(history.state, '');
  }
  return Promise.resolve();
});

export const afterNavigate = vi.fn((listener: () => void) => {
  listeners.add(listener);
});

export const beforeNavigate = vi.fn();

export function navigated(): void {
  for (const listener of listeners) listener();
}

export function resetNavigation(): void {
  listeners.clear();
  goto.mockClear();
  afterNavigate.mockClear();
  beforeNavigate.mockClear();
}
