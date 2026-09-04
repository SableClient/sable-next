import { expect, test } from './fixtures/test';
import { AccountSettings } from './pages/AccountSettings';

test.beforeEach(async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 900 });
});

test.beforeEach(async ({ app }) => {
  await app.openRooms();
});

test('keeps account settings in profile order', async ({ page }) => {
  const account = new AccountSettings(page);
  await account.open();

  const headings = [
    account.profile,
    account.status,
    account.colors,
    account.identity,
    account.biography,
    account.animal,
    account.matrixId,
    account.contacts,
    account.blockedUsers,
  ];
  await Promise.all(headings.map((heading) => expect(heading).toBeVisible()));
  const positions = await Promise.all(headings.map((heading) => heading.boundingBox()));
  const layout = positions.filter(
    (position): position is NonNullable<typeof position> => position !== null
  );
  if (layout.length !== headings.length) throw new Error('Account heading is not laid out.');
  expect(layout.every((position, index) => index === 0 || position.y > layout[index - 1].y)).toBe(
    true
  );
});

test('saves a display name onto the account', async ({ admin, page }) => {
  const account = new AccountSettings(page);
  await account.open();

  const name = `Updated ${String(Date.now())}`;
  await account.displayName.fill(name);
  await account.saveDisplayName.click();

  await expect.poll(() => admin.profile().then((profile) => profile.displayname)).toBe(name);
});

test('a saved name color survives a reload', async ({ page }) => {
  const account = new AccountSettings(page);
  await account.open();

  await account.colorValue('Dark theme name color').fill('#336699');
  await expect(account.colorValue('Dark theme name color')).toHaveValue('#336699');
  await expect(account.colorSave('Dark theme name color')).toBeEnabled();
  await account.colorSave('Dark theme name color').click();

  await page.reload();
  await expect(account.colorValue('Dark theme name color')).toHaveValue('#336699');
});

test('opens a profile color picker next to its swatch', async ({ page }) => {
  const account = new AccountSettings(page);
  await account.open();

  const swatch = account.colorSwatch('Dark theme name color');
  await swatch.scrollIntoViewIfNeeded();
  await swatch.click();

  const picker = account.colorPicker();
  await expect(picker).toBeVisible();

  const [swatchBox, pickerBox] = await Promise.all([swatch.boundingBox(), picker.boundingBox()]);
  expect(swatchBox).not.toBeNull();
  expect(pickerBox).not.toBeNull();
  if (!swatchBox || !pickerBox) throw new Error('Color picker is not laid out.');
  expect(pickerBox.x).toBeGreaterThanOrEqual(swatchBox.x - 1);
  expect(
    pickerBox.y >= swatchBox.y + swatchBox.height || pickerBox.y + pickerBox.height <= swatchBox.y
  ).toBe(true);
});
