import type { Page } from '@playwright/test';

export const RECEIPT_COALESCE_MS = 650;
export const LONG_PRESS_HOLD_MS = 800;
export const NEGATIVE_SETTLE_MS = 500;

export async function nextFrames(page: Page, frames = 3): Promise<void> {
  await page.evaluate(
    (count) =>
      new Promise<void>((resolve) => {
        const step = (left: number): void => {
          if (left === 0) resolve();
          else
            requestAnimationFrame(() => {
              step(left - 1);
            });
        };
        step(count);
      }),
    frames
  );
}

export async function quietFor(page: Page, ms: number): Promise<void> {
  await page.waitForTimeout(ms);
}
