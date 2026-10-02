import en from '../../src/locales/en.json' with { type: 'json' };
import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

const root = '/space/!alpha%3Aexample.test';
const lobby = `${root}/lobby`;

test.beforeEach(async ({ page, installRoomCore }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await installRoomCore('spaces');
});

test('reopening a space after search restores its lobby, including after a reload', async ({
  page,
}) => {
  await page.goto(lobby);
  const rail = page.getByRole('navigation', { name: 'Primary navigation' });
  const space = rail.getByRole('link', { name: 'Alpha', exact: true });
  const rooms = page.getByRole('region', { name: 'Lobby' });
  await expect(rooms.getByRole('heading', { name: 'Alpha', exact: true })).toBeVisible();

  await page.getByRole('link', { name: en.nav.messageSearch }).click();
  await expect(page).toHaveURL(/\/search\?q=.+&space=/);
  await expect(page.getByRole('link', { name: en.nav.lobby, exact: true })).toBeVisible();
  await rail.getByRole('link', { name: en.nav.unspaced, exact: true }).click();
  await space.click();

  await expect(page).toHaveURL(new RegExp(`${lobby}$`));
  await expect(rooms.getByRole('heading', { name: 'Alpha', exact: true })).toBeVisible();

  await page.getByRole('link', { name: en.nav.messageSearch }).click();
  await expect(page).toHaveURL(/\/search\?q=.+&space=/);
  await page.reload();
  await space.click();

  await expect(page).toHaveURL(new RegExp(`${lobby}$`));
  await expect(rooms.getByRole('heading', { name: 'Alpha', exact: true })).toBeVisible();
});

test('an old saved space search opens the lobby through both the rail and the space index', async ({
  page,
}) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      'sable-space-paths',
      JSON.stringify({ '!alpha:example.test': '/search?q=hello&space=!alpha%3Aexample.test' })
    );
  });
  await page.goto('/rooms');
  await page
    .getByRole('navigation', { name: 'Primary navigation' })
    .getByRole('link', { name: 'Alpha', exact: true })
    .click();
  await expect(page).toHaveURL(new RegExp(`${lobby}$`));

  await page.goto(root);
  await expect(page).toHaveURL(new RegExp(`${lobby}$`));
  await expect(
    page.getByRole('region', { name: 'Lobby' }).getByRole('heading', { name: 'Alpha', exact: true })
  ).toBeVisible();
});
