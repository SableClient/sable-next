import { violations } from './fixtures/a11y';
import { expect, test, SIGNED_OUT } from './fixtures/test';

test.use({ storageState: SIGNED_OUT });

const ROOM_ID = '!room:example.test';

test.beforeEach(async ({ page, app, installRoomCore }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await installRoomCore('ready');
  await page.addInitScript(() => {
    window.__e2eRoomState = {
      'fi.mau.meowlnir.protected_rooms': {
        rooms: ['!second:example.test', '!elsewhere:example.test'],
        skip_acl: ['!elsewhere:example.test'],
        protections: { anti_flood: { limit: 10, per: 30 } },
      },
      'fi.mau.meowlnir.watched_lists': {
        lists: [
          { room_id: '!spam:example.test', name: 'Community spam list', shortcode: 'spam' },
          { room_id: '!local:example.test', shortcode: 'local', auto_unban: true },
        ],
      },
    };
  });
  await app.openRoom(ROOM_ID);
});

test('a Meowlnir management room is managed from its Moderation settings', async ({ page }) => {
  await page.getByRole('button', { name: 'More options' }).first().click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Moderation' }).click();

  const protections = page.getByRole('region', { name: 'Protections' });
  await expect(protections.getByRole('spinbutton', { name: 'Limit' })).toHaveValue('10');
  expect(await violations(page, { scope: '[role="dialog"]' })).toEqual([]);

  await protections.getByRole('switch', { name: 'Block media', exact: true }).click();
  await expect(
    protections.getByRole('switch', { name: 'Block media: Allow images' })
  ).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__e2eRoomState?.['fi.mau.meowlnir.protected_rooms']))
    .toMatchObject({ protections: { anti_flood: { limit: 10, per: 30 }, no_media: {} } });
});
