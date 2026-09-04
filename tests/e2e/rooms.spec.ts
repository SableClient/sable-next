import { expect, test, SIGNED_OUT } from './fixtures/test';
import { TIMELINE_ROOM_NAME } from './fixtures/continuwuity';

test.use({ storageState: SIGNED_OUT });

test.beforeEach(async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 720 });
});

test('creates a room and opens it', async ({ page, app, signIn }) => {
  await signIn();
  await app.openCreateRoom();

  const name = `Created room ${String(Date.now())}`;
  await app.createRoomName.fill(name);
  await app.createRoomSubmit.click();

  await expect(page).toHaveURL(/\/rooms\/.+/, { timeout: 15_000 });
  await expect(app.roomHeading(name)).toBeVisible();
  await expect(app.roomLink(name)).toBeVisible();
  await expect(page).toHaveTitle(`${name} - Sable`);
});

test('switches the timeline between two real rooms', async ({ app, timeline, signIn }) => {
  await signIn();
  await app.openCreateRoom();

  const name = `Switch target ${String(Date.now())}`;
  await app.createRoomName.fill(name);
  await app.createRoomSubmit.click();
  await expect(app.roomHeading(name)).toBeVisible({ timeout: 15_000 });

  const body = `Only in the created room ${String(Date.now())}`;
  await app.composer.fill(body);
  await app.composer.press('Enter');
  await timeline.expectMessageSettled(body);

  await expect(app.roomLink(TIMELINE_ROOM_NAME)).toBeVisible({ timeout: 15_000 });
  await app.openRoomFromList(TIMELINE_ROOM_NAME);

  await expect(app.roomHeading(TIMELINE_ROOM_NAME)).toBeVisible();
  await expect(timeline.message(body)).toHaveCount(0);

  await app.openRoomFromList(name);

  await timeline.expectMessageSettled(body);
});
