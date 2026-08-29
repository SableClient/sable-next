import { expect, test } from './fixtures/test';

test.beforeEach(async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
});

test.beforeEach(async ({ app, installRoomCore }) => {
  await installRoomCore('ready');
  await app.openHome();
  await expect(app.primaryNavigation).toBeVisible();
});

test('Mod+K opens the palette and filters rooms as you type', async ({ page }) => {
  await page.keyboard.press('ControlOrMeta+k');

  const dialog = page.getByRole('dialog', { name: 'Jump to room' });
  await expect(dialog).toBeVisible();

  const list = dialog.getByRole('listbox');
  await expect(list.getByRole('option', { name: 'General' })).toBeVisible();
  await expect(list.getByRole('option', { name: 'Random' })).toBeVisible();

  await dialog.getByRole('combobox').fill('Random');
  await expect(list.getByRole('option', { name: 'Random' })).toBeVisible();
  await expect(list.getByRole('option', { name: 'General' })).toHaveCount(0);
});

test('Enter navigates to the selected room', async ({ page, app }) => {
  await page.keyboard.press('ControlOrMeta+k');
  const dialog = page.getByRole('dialog', { name: 'Jump to room' });
  await expect(dialog).toBeVisible();

  await dialog.getByRole('combobox').fill('Random');
  await page.keyboard.press('Enter');

  await expect(dialog).toHaveCount(0);
  await expect(app.roomHeading('Random')).toBeVisible();
});

test('Escape closes the palette and restores focus', async ({ page, app }) => {
  const homeLink = app.homeLink();
  await homeLink.focus();
  await expect(homeLink).toBeFocused();

  await page.keyboard.press('ControlOrMeta+k');
  const dialog = page.getByRole('dialog', { name: 'Jump to room' });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('combobox')).toBeFocused();

  await page.keyboard.press('Escape');

  await expect(dialog).toHaveCount(0);
  await expect(homeLink).toBeFocused();
});

test('a shortcut without allowInEditable does not fire while typing in the composer', async ({
  page,
  app,
}) => {
  await app.openRoom('!room:example.test');
  await app.composer.click();
  await expect(app.composer).toBeFocused();

  await page.keyboard.press('ControlOrMeta+Shift+n');

  await expect(page).not.toHaveURL(/create-room/);
  await expect(app.composer).toBeFocused();
});

test('the same shortcut fires once focus has left the composer', async ({ page, app }) => {
  await app.openRoom('!room:example.test');
  await app.composer.click();
  await expect(app.composer).toBeFocused();
  await app.composer.blur();

  await page.keyboard.press('ControlOrMeta+Shift+n');

  await expect(page).toHaveURL(/create-room/);
});

test('no shortcut fires while a settings dialog is open', async ({ page }) => {
  await page.goto('/settings');
  await expect(page.getByRole('dialog')).toBeVisible();

  await page.keyboard.press('ControlOrMeta+Shift+n');
  await expect(page).not.toHaveURL(/create-room/);
  await expect(page).toHaveURL(/\/settings/);

  await page.keyboard.press('ControlOrMeta+k');
  await expect(page.getByRole('dialog', { name: 'Jump to room' })).toHaveCount(0);
});
