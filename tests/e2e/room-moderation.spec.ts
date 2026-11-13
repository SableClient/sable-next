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
          { room_id: '!second:example.test', name: 'Community spam list', shortcode: 'spam' },
          { room_id: '!local:example.test', shortcode: 'local', auto_unban: true },
        ],
      },
      'm.policy.rule.user': {
        entity: '@spammer:evil.example',
        recommendation: 'm.ban',
        reason: 'Advertising',
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

test('a ban list shows its rules and sends new ones to Meowlnir', async ({ page }) => {
  await page.getByRole('button', { name: 'More options' }).first().click();
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Moderation' }).click();
  await page.getByRole('button', { name: 'Rules and options for Community spam list' }).click();

  const lists = page.getByRole('region', { name: 'Ban lists' });
  await expect(lists.getByText('@spammer:evil.example')).toBeVisible();
  expect(await violations(page, { scope: '[role="dialog"]' })).toEqual([]);

  await lists.getByRole('textbox', { name: 'User, room or server' }).fill('@raider:evil.example');
  await lists.getByRole('textbox', { name: 'Reason' }).fill('raid');
  await lists.getByRole('button', { name: 'Add rule' }).click();

  await expect
    .poll(() =>
      page.evaluate(
        () => window.__e2eCalls.findLast((call) => call.method === 'messages.send')?.params
      )
    )
    .toMatchObject({ room_id: ROOM_ID, body: '!ban spam @raider:evil.example raid' });
});
