import { expect, test } from './fixtures/test';

test.beforeEach(async ({ page }) => {
  test.setTimeout(60_000);
  await page.setViewportSize({ width: 1280, height: 720 });
});

test('sends a message with Enter and keeps the timeline at latest', async ({
  app,
  timeline,
  scratchRoom,
  signIn,
}) => {
  await signIn();
  await app.openRoom(scratchRoom.roomId);
  await expect(app.roomHeading(scratchRoom.name)).toBeVisible();

  const body = `Composed with Enter ${String(Date.now())}`;
  await app.composer.fill(body);
  await app.composer.press('Enter');

  await timeline.expectMessageSettled(body);
  await expect.poll(() => timeline.distanceFromBottom()).toBe(0);
  await expect(app.composer).toHaveText('');
});

test('sends a message with the send button', async ({ app, timeline, scratchRoom, signIn }) => {
  await signIn();
  await app.openRoom(scratchRoom.roomId);
  await expect(app.roomHeading(scratchRoom.name)).toBeVisible();

  const body = `Composed with the button ${String(Date.now())}`;
  await expect(app.sendMessage).toBeDisabled();
  await app.composer.fill(body);
  await expect(app.sendMessage).toBeEnabled();
  await app.sendMessage.click();

  await timeline.expectMessageSettled(body);
});

test('keeps a sent message after a reload', async ({
  page,
  app,
  timeline,
  scratchRoom,
  signIn,
}) => {
  await signIn();
  await app.openRoom(scratchRoom.roomId);
  await expect(app.roomHeading(scratchRoom.name)).toBeVisible();

  const body = `Survives a reload ${String(Date.now())}`;
  await app.composer.fill(body);
  await app.composer.press('Enter');
  await timeline.expectMessageSettled(body);

  await page.reload();

  await timeline.expectMessageSettled(body);
});

test('does not send an empty message', async ({ app, timeline, scratchRoom, signIn }) => {
  await signIn();
  await app.openRoom(scratchRoom.roomId);
  await expect(app.roomHeading(scratchRoom.name)).toBeVisible();
  const body = `Only message ${String(Date.now())}`;
  await app.composer.fill(body);
  await app.composer.press('Enter');
  await timeline.expectMessageSettled(body);
  const newest = await timeline.items.last().innerText();

  await app.composer.press('Enter');

  await expect(app.sendMessage).toBeDisabled();
  await expect(timeline.items.last()).toHaveText(newest);
});
