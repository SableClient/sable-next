import { vi } from 'vitest';

import { page } from './app-state.js';

const listeners = new Set<() => void>();

export const goto = vi.fn((_href: string, options?: { state?: Record<string, unknown> }) => {
  Object.assign(page.state, options?.state);
  return Promise.resolve();
});

export const afterNavigate = vi.fn((listener: () => void) => {
  listeners.add(listener);
});

export function navigated(): void {
  for (const listener of listeners) listener();
}

export function resetNavigation(): void {
  listeners.clear();
  goto.mockClear();
  afterNavigate.mockClear();
}
