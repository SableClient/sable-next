import { expect, test } from './fixtures/test';

test('jumps to an event outside the loaded range', async ({
  page,
  app,
  timeline,
  admin,
  deepRoom,
}) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });

  const distantEventId = deepRoom.eventIds[0];
  const distantBody = deepRoom.bodies[0];
  const replyBody = `Answering something older ${String(Date.now())}`;
  await admin.sendMessage(deepRoom.roomId, replyBody, {
    'm.relates_to': { 'm.in_reply_to': { event_id: distantEventId } },
  });

  await app.openRoom(deepRoom.roomId);
  await timeline.expectRevealed();

  const reply = timeline.container
    .locator('.item')
    .filter({ hasText: replyBody })
    .locator('.reply-preview');
  await expect(reply).toBeVisible({ timeout: 20_000 });
  await expect(timeline.itemByEventId(distantEventId)).toHaveCount(0);

  await reply.click();

  await expect.poll(() => new URL(page.url()).searchParams.get('event')).toBe(distantEventId);
  await expect(timeline.itemByEventId(distantEventId)).toBeVisible({ timeout: 30_000 });
  await expect(timeline.message(distantBody)).toBeVisible();
});
