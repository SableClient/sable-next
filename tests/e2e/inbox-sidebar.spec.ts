import en from '../../src/locales/en.json' with { type: 'json' };
import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

for (const mobile of [false, true]) {
  for (const [path, title] of [
    ['/rooms/!room%3Aexample.test', en.nav.unspaced],
    ['/direct', en.common.directMessages],
    ['/space/!alpha%3Aexample.test/lobby', 'Alpha'],
  ]) {
    test(`${mobile ? 'mobile: ' : ''}Inbox preserves the sidebar from ${path}`, async ({
      page,
      installRoomCore,
    }) => {
      await page.setViewportSize(
        mobile ? { width: 390, height: 844 } : { width: 1280, height: 900 }
      );
      await installRoomCore('spaces');
      await page.goto(path);
      const sidebar = page.locator('.sidebar');
      const heading = sidebar.locator('.room-nav-header h2');
      await expect(heading).toHaveText(title, { timeout: 30_000 });
      const rooms = sidebar.locator('.room-row');
      const names = await rooms.allTextContents();
      const selected = await sidebar
        .locator('.rail [aria-current="page"], .room-nav [aria-current="page"]')
        .evaluateAll((links) => links.map((link) => link.getAttribute('href')));
      if (
        mobile &&
        (await page.locator('#drawer-toggle').getAttribute('aria-pressed')) === 'false'
      ) {
        await page.getByRole('button', { name: en.timeline.back, exact: true }).click();
      }
      await sidebar.locator('a[href="/inbox"]').click();
      await expect(page).toHaveURL(/\/inbox$/);
      await expect(
        page.getByRole('tab', { name: en.inbox.notifications, exact: true })
      ).toBeVisible();
      await expect(heading).toHaveText(title);
      expect(await rooms.allTextContents()).toEqual(names);
      for (const href of selected) {
        if (href)
          await expect(sidebar.locator(`a[href="${href}"]`).first()).toHaveAttribute(
            'aria-current',
            'page'
          );
      }
      await page.getByRole('tab', { name: en.room.membersRequests, exact: true }).click();
      await expect(page).toHaveURL(/\/inbox\?tab=requests$/);
      await expect(heading).toHaveText(title);
      expect(await rooms.allTextContents()).toEqual(names);
      await page.goBack();
      await expect(page).toHaveURL(new RegExp(`${path}$`));
      await expect(heading).toHaveText(title);
    });
  }
}
