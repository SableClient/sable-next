import { expect, test, SIGNED_OUT } from './fixtures/test';
import type { HomeserverProxy } from './fixtures/proxy';

test.use({ storageState: SIGNED_OUT });

function roomPath(roomId: string): string {
  return roomId
    .replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    .replace(/:/g, '(?::|%3A)')
    .replace(/!/g, '(?:!|%21)');
}

function requests(proxy: HomeserverProxy, roomId: string, endpoint: string): number {
  return proxy.count(new RegExp(`^GET /_matrix/client/v3/rooms/${roomPath(roomId)}/${endpoint}`));
}

test('a room of mostly hidden events reaches its start in four history pages', async ({
  page,
  app,
  homeserverProxy,
  proxiedLogin,
}) => {
  test.setTimeout(180_000);
  const account = await proxiedLogin();
  const name = `Sparse ${String(Date.now())}`;
  const roomId = await account.createRoom({ name });
  await account.sendMessage(roomId, 'Sparse first');
  await account.sendMessage(roomId, 'Sparse second');
  const rootId = await account.sendMessage(roomId, 'Sparse root');
  for (let index = 0; index < 120; index += 1) {
    await account.sendMessage(roomId, `* Sparse edit ${String(index)}`, {
      'm.new_content': { msgtype: 'm.text', body: `Sparse edit ${String(index)}` },
      'm.relates_to': { rel_type: 'm.replace', event_id: rootId },
    });
  }
  await page.setViewportSize({ width: 1280, height: 900 });
  await app.openRooms();
  homeserverProxy.clearRequests();

  await app.openRoomFromList(name);

  await expect(page.locator('.timeline-viewport').getByText('Sparse first')).toBeVisible({
    timeout: 30_000,
  });
  expect(requests(homeserverProxy, roomId, 'messages')).toBeLessThanOrEqual(4);
});

test('reopening a room does not fetch its members again', async ({
  page,
  app,
  timeline,
  homeserverProxy,
  proxiedLogin,
}) => {
  test.setTimeout(120_000);
  const account = await proxiedLogin();
  const stamp = String(Date.now());
  const first = `Reopen first ${stamp}`;
  const second = `Reopen second ${stamp}`;
  const firstId = await account.createRoom({ name: first });
  const secondId = await account.createRoom({ name: second });
  await account.sendMessage(firstId, 'First room message');
  await account.sendMessage(secondId, 'Second room message');
  await page.setViewportSize({ width: 1280, height: 900 });
  await app.openRooms();

  await app.openRoomFromList(first);
  await timeline.expectRevealed();
  await expect(page.locator('.timeline-viewport').getByText('First room message')).toBeVisible();
  const fetched = requests(homeserverProxy, firstId, 'members');

  await app.openRoomFromList(second);
  await expect(page.locator('.timeline-viewport').getByText('Second room message')).toBeVisible();
  await app.openRoomFromList(first);
  await expect(page.locator('.timeline-viewport').getByText('First room message')).toBeVisible();
  await page.waitForTimeout(1_000);

  expect(requests(homeserverProxy, firstId, 'members')).toBe(fetched);
});
