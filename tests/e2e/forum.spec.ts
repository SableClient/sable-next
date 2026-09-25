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

test('a forum topic can be deleted from its list', async ({ page, admin }) => {
  const roomId = await admin.createRoom({
    name: `Forum actions ${String(Date.now())}`,
    roomType: 'pl.chrome.forum',
  });
  const topic = 'Remove this rogue topic';
  await admin.sendMessage(roomId, topic);

  await page.goto(`/rooms/${encodeURIComponent(roomId)}`);

  const threads = page.getByRole('list', { name: 'Threads' });
  const thread = threads.getByRole('listitem').filter({ hasText: topic });
  await expect(thread).toBeVisible({ timeout: 30_000 });
  await thread.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Delete message' }).click();
  await page.getByRole('button', { name: 'Delete message' }).click();

  await expect(thread).toHaveCount(0, { timeout: 30_000 });
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

test('resizes a forum thread panel with the keyboard', async ({ page, admin }) => {
  const roomId = await admin.createRoom({
    name: `Forum resize ${String(Date.now())}`,
    roomType: 'pl.chrome.forum',
  });
  await admin.sendMessage(roomId, 'Resize me');

  await page.goto(`/rooms/${encodeURIComponent(roomId)}`);

  const threads = page.getByRole('list', { name: 'Threads' });
  await expect(threads).toBeVisible({ timeout: 30_000 });
  await threads.getByRole('listitem').first().click();

  const resize = page.getByRole('slider', { name: 'Thread' });
  await expect(resize).toHaveAttribute('aria-valuenow', '27.5');
  await resize.press('ArrowLeft');
  await expect(resize).toHaveAttribute('aria-valuenow', '32.5');
});
