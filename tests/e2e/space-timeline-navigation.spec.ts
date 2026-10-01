import en from '../../src/locales/en.json' with { type: 'json' };
import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

for (const entry of ['lobby button', 'space menu']) {
  test(`opening a space timeline from its ${entry} keeps its sidebar selected`, async ({
    page,
    installRoomCore,
  }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installRoomCore('spaces');
    await page.addInitScript(() => {
      localStorage.setItem('sable-preferences', JSON.stringify({ developerTools: true }));
    });
    await page.goto(entry === 'lobby button' ? '/space/!alpha%3Aexample.test/lobby' : '/rooms');

    const sidebar = page.getByRole('navigation', { name: 'Primary navigation' });
    const space = sidebar.getByRole('link', { name: 'Alpha', exact: true });
    if (entry === 'lobby button') {
      await page.getByRole('button', { name: en.room.menuShowSpaceTimeline, exact: true }).click();
    } else {
      await space.click({ button: 'right' });
      await page.getByRole('menuitem', { name: en.room.menuShowSpaceTimeline }).click();
    }

    await expect(page).toHaveURL(
      /\/space\/!alpha%3Aexample.test\/!alpha%3Aexample.test\?timeline=events$/
    );
    await expect(sidebar.getByRole('heading', { name: 'Alpha', exact: true })).toBeVisible();
    await expect(space).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('log', { name: 'Timeline' })).toContainText('Alpha message');

    await page.reload();
    await expect(space).toHaveAttribute('aria-current', 'page');
    await expect(sidebar.getByRole('heading', { name: 'Alpha', exact: true })).toBeVisible();
    await expect(page.getByRole('log', { name: 'Timeline' })).toContainText('Alpha message');

    await sidebar.getByRole('link', { name: en.nav.unspaced, exact: true }).click();
    await space.click();
    await expect(page).toHaveURL(
      /\/space\/!alpha%3Aexample.test\/!alpha%3Aexample.test\?timeline=events$/
    );
    await expect(sidebar.getByRole('heading', { name: 'Alpha', exact: true })).toBeVisible();
  });
}
