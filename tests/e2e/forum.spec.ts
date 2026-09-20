import { expect, test } from './fixtures/test';

test.beforeEach(async ({ page }) => {
  test.setTimeout(90_000);
  await page.setViewportSize({ width: 1280, height: 900 });
});

test('a forum room opens on its thread list', async ({ page, admin }) => {
  const roomId = await admin.createRoom({
    name: `Forum ${String(Date.now())}`,
    roomType: 'pl.chrome.forum',
  });
  const rootId = await admin.sendMessage(roomId, 'First topic');
  await admin.sendMessage(roomId, 'A reply in the topic', {
    'm.relates_to': { rel_type: 'm.thread', event_id: rootId },
  });

  await page.goto(`/rooms/${encodeURIComponent(roomId)}`);

  const threads = page.getByRole('list', { name: 'Threads' });
  await expect(threads).toBeVisible({ timeout: 30_000 });
  await expect(threads.getByRole('listitem')).toHaveCount(1);
  await expect(threads).toContainText('First topic');
});

test('a room v12 forum opens on its thread list', async ({ page, admin }) => {
  const roomId = await admin.createRoom({
    name: `Forum v12 ${String(Date.now())}`,
    roomType: 'pl.chrome.forum',
    version: '12',
  });
  const rootId = await admin.sendMessage(roomId, 'First topic');
  await admin.sendMessage(roomId, 'A reply in the topic', {
    'm.relates_to': { rel_type: 'm.thread', event_id: rootId },
  });

  await page.goto(`/rooms/${encodeURIComponent(roomId)}`);

  const threads = page.getByRole('list', { name: 'Threads' });
  await expect(threads).toBeVisible({ timeout: 30_000 });
  await expect(threads).toContainText('First topic');
});

test('a forum post with no replies is listed as a topic', async ({ page, admin }) => {
  const roomId = await admin.createRoom({
    name: `Forum quiet ${String(Date.now())}`,
    roomType: 'pl.chrome.forum',
  });
  await admin.sendMessage(roomId, 'A topic nobody answered');

  await page.goto(`/rooms/${encodeURIComponent(roomId)}`);

  const threads = page.getByRole('list', { name: 'Threads' });
  await expect(threads).toBeVisible({ timeout: 30_000 });
  await expect(threads).toContainText('A topic nobody answered');
});

test('a forum inside a space opens on its thread list', async ({ page, admin }) => {
  const spaceId = await admin.createRoom({ name: `Space ${String(Date.now())}`, isSpace: true });
  const roomId = await admin.createRoom({
    name: `Forum child ${String(Date.now())}`,
    roomType: 'pl.chrome.forum',
  });
  await admin.addSpaceChild(spaceId, roomId);
  const rootId = await admin.sendMessage(roomId, 'Spaced topic');
  await admin.sendMessage(roomId, 'A reply', {
    'm.relates_to': { rel_type: 'm.thread', event_id: rootId },
  });

  await page.goto(`/space/${encodeURIComponent(spaceId)}/${encodeURIComponent(roomId)}`);

  const threads = page.getByRole('list', { name: 'Threads' });
  await expect(threads).toBeVisible({ timeout: 30_000 });
  await expect(threads).toContainText('Spaced topic');
});

test('a topic older than the sync window is paged in', async ({ page, admin }) => {
  const roomId = await admin.createRoom({
    name: `Forum buried ${String(Date.now())}`,
    roomType: 'pl.chrome.forum',
  });
  const rootId = await admin.sendMessage(roomId, 'Buried topic');
  for (let index = 0; index < 25; index += 1) {
    await admin.sendMessage(roomId, `Reply ${String(index)}`, {
      'm.relates_to': { rel_type: 'm.thread', event_id: rootId },
    });
  }

  await page.goto(`/rooms/${encodeURIComponent(roomId)}`);

  const threads = page.getByRole('list', { name: 'Threads' });
  await expect(threads).toBeVisible({ timeout: 30_000 });
  await expect(threads).toContainText('Buried topic');
});

test('opening a topic shows the thread panel', async ({ page, admin }) => {
  const roomId = await admin.createRoom({
    name: `Forum thread ${String(Date.now())}`,
    roomType: 'pl.chrome.forum',
  });
  const rootId = await admin.sendMessage(roomId, 'Open me');
  await admin.sendMessage(roomId, 'The answer', {
    'm.relates_to': { rel_type: 'm.thread', event_id: rootId },
  });

  await page.goto(`/rooms/${encodeURIComponent(roomId)}`);

  const threads = page.getByRole('list', { name: 'Threads' });
  await expect(threads).toBeVisible({ timeout: 30_000 });
  await threads.getByRole('listitem').first().click();

  const thread = page.getByRole('complementary', { name: 'Thread' });
  await expect(thread).toBeVisible();
  await expect(thread).toContainText('The answer');
});
