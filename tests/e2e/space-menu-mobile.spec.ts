import { expect, test } from './fixtures/test';

test.use({ hasTouch: true, viewport: { width: 412, height: 915 } });

test('mobile: the space create menu opens the selected destination', async ({
  page,
  spaceTree,
}) => {
  await page.goto(`/space/${encodeURIComponent(spaceTree.alphaId)}`);

  await page.getByRole('button', { name: 'Create room in Space' }).click();
  const menu = page.getByRole('dialog', { name: 'Create room in Space' });
  await expect(menu).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Join with Address' }).click();

  await expect(page).toHaveURL(/\/explore#explore-join-by-address$/);
});
