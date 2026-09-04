import type { Locator, Page } from '@playwright/test';

import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

function rail(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Primary navigation' });
}

function railLink(page: Page, name: string): Locator {
  return rail(page).getByRole('link', { name });
}

function railSpaces(page: Page): Locator {
  return rail(page).locator('.rail-slot a[href^="/space/"]');
}

async function spaceOrder(page: Page): Promise<(string | null)[]> {
  return railSpaces(page).evaluateAll((links) =>
    links.map((link) => link.getAttribute('aria-label'))
  );
}

async function openRail(page: Page): Promise<void> {
  await page.goto('/rooms');
  await expect(railSpaces(page)).toHaveCount(3, { timeout: 90_000 });
}

async function reorder(
  page: Page,
  source: string,
  target: string,
  targetPosition: { x: number; y: number },
  expected: string[]
): Promise<void> {
  await expect(async () => {
    await railLink(page, source).dragTo(railLink(page, target), { targetPosition });
    await expect(spaceOrder(page)).resolves.toEqual(expected);
  }).toPass({ timeout: 30_000 });
}

async function group(page: Page): Promise<void> {
  await expect(async () => {
    await railLink(page, 'Beta').dragTo(railLink(page, 'Alpha'));
    await expect(page.getByRole('button', { name: 'Alpha, Beta' })).toBeVisible({
      timeout: 3_000,
    });
  }).toPass({ timeout: 30_000 });
}

test.beforeEach(async ({ page, spacesLogin }) => {
  test.setTimeout(120_000);
  await page.setViewportSize({ width: 1280, height: 900 });
  await spacesLogin();
});

test('dragging one space onto another groups them into a folder', async ({ page }) => {
  await openRail(page);

  await group(page);

  const folder = page.getByRole('button', { name: 'Alpha, Beta' });
  await expect(folder).toHaveAttribute('aria-expanded', 'false');
  await expect(spaceOrder(page)).resolves.toEqual(['Gamma']);

  await page.reload();
  await expect(page.getByRole('button', { name: 'Alpha, Beta' })).toBeVisible();
});

test('dragging above or below a space reorders the rail', async ({ page }) => {
  await openRail(page);

  await reorder(page, 'Gamma', 'Alpha', { x: 20, y: 2 }, ['Gamma', 'Alpha', 'Beta']);
  await reorder(page, 'Gamma', 'Beta', { x: 20, y: 40 }, ['Alpha', 'Beta', 'Gamma']);
});

test('a folder opens to its spaces and takes another one by drag', async ({ page }) => {
  await openRail(page);
  await group(page);

  await page.getByRole('button', { name: 'Alpha, Beta' }).click();
  await expect(spaceOrder(page)).resolves.toEqual(['Alpha', 'Beta', 'Gamma']);

  await expect(async () => {
    await railLink(page, 'Gamma').dragTo(railLink(page, 'Alpha'), {
      targetPosition: { x: 17, y: 30 },
    });
    await expect(page.getByRole('button', { name: 'Collapse Alpha, Gamma, Beta' })).toBeVisible({
      timeout: 3_000,
    });
  }).toPass({ timeout: 30_000 });
  await expect(spaceOrder(page)).resolves.toEqual(['Alpha', 'Gamma', 'Beta']);
});

test('a folder can be taken apart from its menu', async ({ page }) => {
  await openRail(page);
  await group(page);
  await page.getByRole('button', { name: 'Alpha, Beta' }).click();

  await page.getByRole('button', { name: 'Collapse Alpha, Beta' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Ungroup folder' }).click();

  await expect(spaceOrder(page)).resolves.toEqual(['Alpha', 'Beta', 'Gamma']);
  await expect(page.getByRole('button', { name: /^Collapse/ })).toHaveCount(0);
});

test('a space can be lifted out of a folder that holds only it', async ({ page }) => {
  await openRail(page);
  await group(page);
  await page.getByRole('button', { name: 'Alpha, Beta' }).click();

  await railLink(page, 'Beta').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Remove from folder' }).click();
  await expect(page.getByRole('button', { name: 'Collapse Alpha' })).toBeVisible();

  await railLink(page, 'Alpha').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Remove from folder' }).click();

  await expect(page.getByRole('button', { name: /^Collapse/ })).toHaveCount(0);
  await expect(railSpaces(page)).toHaveCount(3);
});

test('a folder can be renamed, and the name shown instead of the space names', async ({ page }) => {
  await openRail(page);
  await group(page);

  await page.getByRole('button', { name: 'Alpha, Beta' }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename folder' }).click();

  const field = page.getByRole('textbox', { name: 'Folder name' });
  await expect(field).toHaveValue('Alpha, Beta');
  await field.fill('Work');
  await page.getByRole('button', { name: 'Save' }).click();

  await expect(page.getByRole('button', { name: 'Work' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('button', { name: 'Work' })).toBeVisible();
});
