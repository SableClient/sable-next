import en from '../../src/locales/en.json' with { type: 'json' };
import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

test('opens a joined room from Explore spaces when Home is disabled', async ({
  page,
  app,
  installRoomCore,
}) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await installRoomCore('ready');
  await page.addInitScript(() => {
    localStorage.setItem('sable-preferences', JSON.stringify({ showHome: false }));
  });
  await app.openRooms();

  const explore = app.primaryNavigation.getByRole('link', { name: en.nav.exploreSpaces });
  await explore.click();
  await expect(page).toHaveURL(/\/explore$/);
  await expect(explore).toHaveAttribute('aria-current', 'page');
  await app.primaryNavigation.getByRole('treeitem', { name: /^General\b/ }).click();

  await expect(page).toHaveURL(/\/rooms\/!room%3Aexample.test$/);
  await expect(page.getByRole('feed', { name: 'Timeline' })).toContainText('General message 19');
});
