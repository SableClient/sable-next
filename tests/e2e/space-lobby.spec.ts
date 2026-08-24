import { expect, test } from './fixtures/test';

const LOBBY = '/space/!alpha%3Aexample.test/lobby';

test('the lobby pages the hierarchy through to the end without a click', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('spaces');
  await page.goto(LOBBY);

  await expect(page.locator('.room-name', { hasText: 'Late Arrival' })).toBeVisible();
  await expect(page.locator('.room-name', { hasText: 'Deep Room' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);
});

test('a first page with nothing renderable is not reported as an empty space', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('spaces');
  await page.goto(LOBBY);

  await expect(page.getByText('This space has no rooms yet.')).toHaveCount(0);
  await expect(page.locator('.room-name', { hasText: 'Late Arrival' })).toBeVisible();
});

test('a room from a later page lands under its own subspace heading', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('spaces');
  await page.goto(LOBBY);

  await expect(page.locator('.room-name', { hasText: 'Deep Room' })).toBeVisible();
  await expect(page.locator('.section-name', { hasText: 'Nested' })).toBeVisible();
});

test('the lobby names the space it is showing', async ({ page, installRoomCore }) => {
  await installRoomCore('spaces');
  await page.goto(LOBBY);

  await expect(page.getByRole('heading', { level: 1, name: 'Alpha' })).toBeVisible();
});

test('switching spaces does not leave the previous space rooms on screen', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('spaces');
  await page.goto(LOBBY);
  await expect(page.locator('.room-name', { hasText: 'Late Arrival' })).toBeVisible();

  await page.goto('/space/!beta%3Aexample.test/lobby');

  await expect(page.locator('.room-name', { hasText: 'Late Arrival' })).toHaveCount(0);
  await expect(page.getByRole('heading', { level: 1, name: 'Beta' })).toBeVisible();
});

test('the keyboard move sends one order for the room that moved', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('spaces');
  await page.goto(LOBBY);

  const rooms = page.locator('.section .rooms').first().locator('.room-name');
  await expect(rooms).toHaveText([/Late Arrival/, /Middle Room/, /Tail Room/]);

  await page
    .locator('.room', { has: page.locator('.room-name', { hasText: 'Tail Room' }) })
    .getByRole('button', { name: 'Room options' })
    .click();
  await page.getByRole('menuitem', { name: 'Move up' }).click();

  await expect(rooms).toHaveText([/Late Arrival/, /Tail Room/, /Middle Room/]);

  const sent = await page.evaluate(
    () =>
      JSON.parse(sessionStorage.getItem('e2e-space-child-order') ?? '[]') as {
        space_id: string;
        room_id: string;
        order: string | null;
      }[]
  );
  expect(sent).toHaveLength(1);
  expect(sent[0]?.room_id).toBe('!tail:example.test');
  expect(sent[0]?.space_id).toBe('!alpha:example.test');
  expect(typeof sent[0]?.order).toBe('string');
});

test('moving the first room up does nothing', async ({ page, installRoomCore }) => {
  await installRoomCore('spaces');
  await page.goto(LOBBY);

  const rooms = page.locator('.section .rooms').first().locator('.room-name');
  await expect(rooms).toHaveText([/Late Arrival/, /Middle Room/, /Tail Room/]);

  await page
    .locator('.room', { has: page.locator('.room-name', { hasText: 'Late Arrival' }) })
    .getByRole('button', { name: 'Room options' })
    .click();
  await page.getByRole('menuitem', { name: 'Move up' }).click();

  await expect(rooms).toHaveText([/Late Arrival/, /Middle Room/, /Tail Room/]);
  expect(await page.evaluate(() => sessionStorage.getItem('e2e-space-child-order'))).toBeNull();
});

test('a dragged room is dropped where the indicator showed', async ({ page, installRoomCore }) => {
  await installRoomCore('spaces');
  await page.goto(LOBBY);

  const rooms = page.locator('.section .rooms').first().locator('.room-name');
  await expect(rooms).toHaveText([/Late Arrival/, /Middle Room/, /Tail Room/]);

  const source = page.locator('.room', {
    has: page.locator('.room-name', { hasText: 'Tail Room' }),
  });
  const target = page.locator('.room', {
    has: page.locator('.room-name', { hasText: 'Late Arrival' }),
  });

  await source.dragTo(target, { targetPosition: { x: 20, y: 2 } });

  await expect(rooms).toHaveText([/Tail Room/, /Late Arrival/, /Middle Room/]);
});

test('a room shows a drag handle when the account can manage the space', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('spaces');
  await page.goto(LOBBY);

  await expect(page.locator('.room-name', { hasText: 'Late Arrival' })).toBeVisible();
  await expect(page.locator('.drag-handle').first()).toBeVisible();
});

test('a subspace the server refuses is not reported as a broken lobby', async ({
  page,
  installRoomCore,
}) => {
  await installRoomCore('spaces');
  await page.goto(LOBBY);

  await expect(page.locator('.section-name', { hasText: 'Refused Space' })).toBeVisible();
  await expect(page.locator('.room-name', { hasText: 'Late Arrival' })).toBeVisible();
  await expect(page.getByRole('alert')).toHaveCount(0);
  await expect(page.locator('.section-failed')).toHaveCount(1);
});

test('a long topic is clamped in the hero and opens in full', async ({ page, installRoomCore }) => {
  await installRoomCore('spaces');
  await page.goto(LOBBY);

  const topic = page.locator('.topic');
  await expect(topic).toBeVisible();

  const clamped = await page
    .locator('.topic-text')
    .evaluate((element) => element.scrollHeight > element.clientHeight + 1);
  expect(clamped).toBe(true);

  await topic.click();
  await expect(page.getByRole('dialog', { name: 'Topic' })).toBeVisible();
  await expect(page.locator('.topic-full')).toContainText('past the three lines');
});

test('the whole lobby scrolls, hero included', async ({ page, installRoomCore }) => {
  await installRoomCore('spaces');
  await page.setViewportSize({ width: 900, height: 400 });
  await page.goto(LOBBY);
  await expect(page.locator('.room-name', { hasText: 'Late Arrival' })).toBeVisible();

  const scrolled = await page.locator('.lobby-page').evaluate((element) => {
    element.scrollTop = element.scrollHeight;
    return element.scrollTop;
  });
  expect(scrolled).toBeGreaterThan(0);
  await expect(page.getByRole('heading', { level: 1, name: 'Alpha' })).not.toBeInViewport();
});
