import { expect, test, vi } from 'vitest';
import { page } from 'vitest/browser';
import { render } from 'vitest-browser-svelte';

vi.mock('#lib/platform/overlay-back.svelte.js', () => ({ holdOverlayBack: () => {} }));

import Harness from './DialogFrameHarness.test.svelte';

test('a closing dialog does not intercept pointer events while its exit animation runs', async () => {
  const style = document.createElement('style');
  style.textContent =
    '.dialog-backdrop[data-state="closed"] { animation: hold 60s forwards; } @keyframes hold { to { opacity: 0.5; } }';
  document.head.append(style);
  const screen = await render(Harness, { open: true });
  await expect.element(page.getByRole('dialog', { name: 'Panel' })).toBeVisible();

  const backdrop = document.querySelector('.dialog-backdrop');
  expect(backdrop).not.toBeNull();
  (document.querySelector('.dialog-content') as HTMLElement).dispatchEvent(
    new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })
  );
  await vi.waitFor(() => {
    expect(backdrop?.getAttribute('data-state')).toBe('closed');
  });
  expect(backdrop?.isConnected).toBe(true);
  expect(getComputedStyle(backdrop as Element).pointerEvents).toBe('none');
  expect(document.elementsFromPoint(5, 5)).not.toContain(backdrop);
  await screen.unmount();
  style.remove();
});
