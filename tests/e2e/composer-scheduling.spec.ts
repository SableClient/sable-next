import { expect, SIGNED_OUT, test } from './fixtures/test';

const SCHEDULE_PRESS_MS = 800;

test.use({ storageState: SIGNED_OUT });

test.beforeEach(async ({ app, installRoomCore }) => {
  await installRoomCore('ready');
  await app.openRoom('!room:example.test');
});

test('touch taps and mouse clicks send without scheduling', async ({
  page,
  app,
  core,
  hasTouch,
}) => {
  const send = page.locator('.composer-send');
  for (let index = 0; index < 3; index += 1) {
    await app.composer.fill(`Message ${String(index)}`);
    if (hasTouch) await send.tap();
    else await send.click();
    await expect(app.composer).toHaveText('');
    await expect(page.getByText('Schedule this message', { exact: true })).toBeHidden();
  }
  expect((await core.commands()).filter((command) => command === 'send_message')).toHaveLength(3);
});

test('an untyped touch contextmenu cannot bypass the schedule delay', async ({ page, app }) => {
  await app.composer.fill('Later');
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  const send = page.locator('.composer-send');
  await send.dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true });
  await page.clock.runFor(100);
  await send.dispatchEvent('pointerup', { pointerType: 'touch', isPrimary: true });
  await page.clock.runFor(500);
  await send.evaluate((node) => {
    node.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true }));
    node.dispatchEvent(
      new PointerEvent('contextmenu', { bubbles: true, cancelable: true, pointerType: '' })
    );
  });
  await page.clock.runFor(SCHEDULE_PRESS_MS);
  await expect(page.getByText('Schedule this message', { exact: true })).toBeHidden();
  await expect(app.composer).toHaveText('Later');
});

test('a touch hold schedules only after the full delay and swallows its click', async ({
  page,
  app,
  core,
}) => {
  await app.composer.fill('Later');
  await page.clock.install();
  await page.clock.pauseAt(new Date(Date.now() + 1000));
  const send = page.locator('.composer-send');
  await send.dispatchEvent('pointerdown', { pointerType: 'touch', isPrimary: true });
  await page.clock.runFor(SCHEDULE_PRESS_MS - 1);
  await expect(page.getByText('Schedule this message', { exact: true })).toBeHidden();
  await page.clock.runFor(1);
  await expect(page.getByText('Schedule this message', { exact: true })).toBeVisible();
  await send.dispatchEvent('pointerup', { pointerType: 'touch', isPrimary: true });
  await send.dispatchEvent('click', { bubbles: true, cancelable: true });
  expect(await core.commands()).not.toContain('send_message');
});
