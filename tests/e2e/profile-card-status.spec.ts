import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

test.beforeEach(async ({ page, app, installRoomCore }) => {
  await page.addInitScript(() => {
    (window as unknown as { __e2eProfilePatch: object }).__e2eProfilePatch = {
      status: {
        text: 'A long status that needs scrolling to read in full. '.repeat(30),
        emoji: '💭',
      },
    };
  });
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
  await page.getByRole('button', { name: "Open Alice's profile" }).last().click();
});

test('keyboard focus reveals the status and lets the reader scroll it', async ({ page }) => {
  const status = page.getByRole('region', { name: 'Status', exact: true });
  const bubble = page.locator('.profile-card-status');
  await page.locator('.profile-card-user-id').focus();
  await page.mouse.move(0, 0);
  await expect(status).toHaveCSS('overflow-y', 'hidden');

  await status.focus();
  await page.keyboard.press('Shift+Tab');
  await page.keyboard.press('Tab');
  await expect(status).toBeFocused();
  await expect(status).toHaveCSS('overflow-y', 'auto');
  await page.keyboard.press('ArrowDown');
  await expect.poll(() => status.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
  await page.keyboard.press('Space');
  await expect.poll(() => status.evaluate((node) => node.scrollTop)).toBeGreaterThan(30);

  // Leaving the bubble with the pointer must not collapse keyboard-focused text.
  await bubble.hover();
  await page.mouse.move(0, 0);
  await expect(status).toHaveCSS('overflow-y', 'auto');
  await page.keyboard.press('Tab');
  await expect(status).toHaveCSS('overflow-y', 'hidden');
  await expect.poll(() => status.evaluate((node) => node.scrollTop)).toBe(0);
});

test('a hovered status clears the name and message action', async ({ page }) => {
  const status = page.getByRole('region', { name: 'Status', exact: true });
  await page.locator('.profile-card-user-id').focus();
  await page.locator('.profile-card-status').hover();
  await expect(status).toHaveCSS('overflow-y', 'auto');
  const bubble = await page.locator('.profile-card-status').boundingBox();
  const identity = await page.locator('.profile-card-identity').boundingBox();
  if (!bubble || !identity) throw new Error('Profile card is not laid out');
  expect(bubble.y + bubble.height).toBeLessThanOrEqual(identity.y);
  await page.getByRole('button', { name: 'Message', exact: true }).click();
  await expect(page.locator('.profile-card')).toBeHidden();
});

test('mobile: an expanded status stays inside the card and above its controls', async ({
  page,
}) => {
  const status = page.getByRole('region', { name: 'Status', exact: true });
  await status.focus();
  await expect(status).toHaveCSS('overflow-y', 'auto');
  const card = await page.locator('.profile-card').boundingBox();
  const bubble = await page.locator('.profile-card-status').boundingBox();
  const identity = await page.locator('.profile-card-identity').boundingBox();
  if (!card || !bubble || !identity) throw new Error('Profile card is not laid out');
  expect(bubble.x).toBeGreaterThanOrEqual(card.x);
  expect(bubble.x + bubble.width).toBeLessThanOrEqual(card.x + card.width);
  expect(bubble.y + bubble.height).toBeLessThanOrEqual(identity.y);
  await status.press('End');
  await expect.poll(() => status.evaluate((node) => node.scrollTop)).toBeGreaterThan(0);
});

test('mobile: opening a chat from the profile sheet lands on the direct message', async ({
  page,
}) => {
  await page.getByRole('dialog').getByRole('button', { name: 'Open chat' }).click();
  await expect(page).toHaveURL(/\/direct\/!dm%3Aexample\.test$/);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});
