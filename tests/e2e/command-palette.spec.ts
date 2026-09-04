import { expect, test as base } from './fixtures/test';

type Palette = { firstName: string; secondName: string; firstRoomId: string };

const test = base.extend<{ palette: Palette }>({
  palette: async ({ app }, use) => {
    const stamp = String(Date.now());
    const firstName = `Palette alpha ${stamp}`;
    const secondName = `Palette omega ${stamp}`;
    const firstRoomId = await app.createRoom(firstName);
    await app.createRoom(secondName);
    await app.openRooms();
    await expect(app.primaryNavigation).toBeVisible();
    await use({ firstName, secondName, firstRoomId });
  },
});

test.beforeEach(async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
});

test.describe('the jump-to-room palette', () => {
  test('Mod+K opens the palette and filters rooms as you type', async ({ page, palette }) => {
    await page.keyboard.press('ControlOrMeta+k');

    const dialog = page.getByRole('dialog', { name: 'Jump to room' });
    await expect(dialog).toBeVisible();

    const list = dialog.getByRole('listbox');
    await expect(list.getByRole('option', { name: palette.firstName })).toBeVisible();
    await expect(list.getByRole('option', { name: palette.secondName })).toBeVisible();

    await dialog.getByRole('combobox').fill(palette.secondName);
    await expect(list.getByRole('option', { name: palette.secondName })).toBeVisible();
    await expect(list.getByRole('option', { name: palette.firstName })).toHaveCount(0);
  });

  test('Enter navigates to the selected room', async ({ page, app, palette }) => {
    await page.keyboard.press('ControlOrMeta+k');
    const dialog = page.getByRole('dialog', { name: 'Jump to room' });
    await expect(dialog).toBeVisible();

    await dialog.getByRole('combobox').fill(palette.secondName);
    await expect(dialog.getByRole('option', { name: palette.secondName })).toBeVisible();
    await page.keyboard.press('Enter');

    await expect(dialog).toHaveCount(0);
    await expect(app.roomHeading(palette.secondName)).toBeVisible();
  });

  test('Escape closes the palette and restores focus', async ({ page, app, palette }) => {
    void palette;
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
    palette,
  }) => {
    await app.openRoom(palette.firstRoomId);
    await app.composer.click();
    await expect(app.composer).toBeFocused();

    await page.keyboard.press('ControlOrMeta+Shift+n');

    await expect(page).not.toHaveURL(/create-room/);
    await expect(app.composer).toBeFocused();
  });

  test('the same shortcut fires once focus has left the composer', async ({
    page,
    app,
    palette,
  }) => {
    await app.openRoom(palette.firstRoomId);
    await app.composer.click();
    await expect(app.composer).toBeFocused();
    await app.composer.blur();

    await page.keyboard.press('ControlOrMeta+Shift+n');

    await expect(page).toHaveURL(/create-room/);
  });
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
